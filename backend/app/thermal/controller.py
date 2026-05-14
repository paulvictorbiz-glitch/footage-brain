"""
Thermal controller — polls sensors and adjusts pipeline pacing to prevent
CPU thermal throttling.

Runs as a daemon thread; if it crashes, transcription continues unaffected.
All public methods are thread-safe.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Deque, Optional, Tuple

from app.core.logging import get_logger
from app.thermal.events import (
    EVT_BACKOFF, EVT_RECOVERY, EVT_SENSOR_FAIL,
    EVT_STATE_CHANGE, EVT_THROTTLE_END, EVT_THROTTLE_START,
    EVT_THRESHOLD_CROSSED, get_event_logger,
)
from app.thermal.sensors import SensorReading, get_sensor_provider

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Configuration dataclass
# ---------------------------------------------------------------------------

@dataclass
class ThermalConfig:
    selected_limit: float = 85.0        # °C; 999 = Auto; -1 = monitor-only
    auto_mode: bool = True
    poll_interval_ms: int = 3000
    rolling_avg_window_min: float = 5.0
    cooldown_threshold_c: float = 8.0   # how far below limit before relaxing
    resume_threshold_c: float = 12.0    # how far below limit before full recovery
    throttle_backoff_step: float = 5.0  # seconds to add on throttle event
    recovery_step: float = 1.0          # seconds to remove per recovery tick
    min_time_between_adjustments_sec: int = 20
    default_batch_size: int = 0         # 0 = unlimited
    monitor_only: bool = False


# ---------------------------------------------------------------------------
# State enum
# ---------------------------------------------------------------------------

class ThermalState(Enum):
    OPTIMAL            = "optimal"
    WARM               = "warm"
    COOLING            = "cooling"
    THROTTLING         = "throttling_detected"
    RECOVERING         = "recovering"
    MONITOR_ONLY       = "monitor_only"
    SENSOR_UNAVAILABLE = "sensor_unavailable"


# ---------------------------------------------------------------------------
# Status snapshot dataclass (returned by API)
# ---------------------------------------------------------------------------

@dataclass
class ThermalStatus:
    state: str = ThermalState.OPTIMAL.value
    current_temp: Optional[float] = None
    rolling_avg: Optional[float] = None
    session_avg: Optional[float] = None
    peak_temp: Optional[float] = None
    cpu_load: Optional[float] = None
    effective_clock_mhz: Optional[float] = None
    is_throttling: Optional[bool] = None
    throttle_source: str = "unknown"
    provider: str = "unavailable"
    sensor_name: str = ""
    time_throttling_sec: float = 0.0
    current_delay_sec: float = 0.0
    auto_limit_effective: float = 88.0
    status_message: str = "Sensor unavailable"
    last_update: Optional[str] = None
    is_stale: bool = True
    config: Optional[ThermalConfig] = None


# ---------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------

class ThermalController:
    """
    Polls the sensor every poll_interval_ms, maintains temperature history,
    and adjusts pipeline pacing via pipeline_worker.set_pacing(delay_seconds).
    """

    # State machine delays (seconds) — overridden mid-run
    _STATE_DELAYS = {
        ThermalState.OPTIMAL:            0.0,
        ThermalState.WARM:               2.0,
        ThermalState.COOLING:            8.0,
        ThermalState.THROTTLING:        15.0,
        ThermalState.RECOVERING:         4.0,
        ThermalState.MONITOR_ONLY:       0.0,
        ThermalState.SENSOR_UNAVAILABLE: 0.0,
    }

    def __init__(self, pipeline_worker: Any) -> None:
        self._worker = pipeline_worker
        self._config = ThermalConfig()
        self._config_lock = threading.Lock()

        self._state = ThermalState.SENSOR_UNAVAILABLE
        self._state_lock = threading.Lock()

        self._sensor = get_sensor_provider()
        self._event_log = get_event_logger()

        # Rolling window: deque of (monotonic_time, temp)
        self._window: Deque[Tuple[float, float]] = deque()
        self._window_lock = threading.Lock()

        # Session statistics
        self._session_temps: list[float] = []
        self._peak_temp: Optional[float] = None

        # Throttle tracking
        self._throttle_start: Optional[float] = None   # monotonic
        self._total_throttle_sec: float = 0.0
        self._last_throttle_end: Optional[float] = None

        # State timing
        self._state_entered_at: float = time.monotonic()
        self._last_adjustment: float = 0.0

        # Current delay applied to pipeline
        self._current_delay: float = 0.0

        # Auto-mode effective limit
        self._auto_limit: float = 88.0

        # Status snapshot
        self._status: ThermalStatus = ThermalStatus()
        self._status_lock = threading.Lock()

        # Thread
        self._running = False
        self._thread: Optional[threading.Thread] = None

        # Clock history for inferred throttle
        self._clock_history: Deque[Tuple[float, float]] = deque(maxlen=10)

    # ------------------------------------------------------------------
    # Public control
    # ------------------------------------------------------------------

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._safe_control_loop,
            daemon=True,
            name="thermal-controller",
        )
        self._thread.start()
        logger.info("thermal_controller_started")

    def stop(self) -> None:
        self._running = False
        logger.info("thermal_controller_stopped")

    def get_status(self) -> ThermalStatus:
        with self._status_lock:
            return self._status

    def get_config(self) -> ThermalConfig:
        with self._config_lock:
            return self._config

    def update_config(self, updates: dict) -> ThermalConfig:
        with self._config_lock:
            for k, v in updates.items():
                if hasattr(self._config, k):
                    setattr(self._config, k, v)
            cfg = self._config
        logger.info("thermal_config_updated", updates=updates)
        return cfg

    # ------------------------------------------------------------------
    # Internal loop
    # ------------------------------------------------------------------

    def _safe_control_loop(self) -> None:
        """Outer wrapper — never lets the loop crash the daemon thread."""
        while self._running:
            try:
                self._control_loop()
            except Exception as exc:
                logger.error("thermal_loop_crash", error=str(exc))
                self._event_log.log(EVT_SENSOR_FAIL, f"Controller crash: {exc}")
                time.sleep(10)

    def _control_loop(self) -> None:
        while self._running:
            with self._config_lock:
                cfg = self._config
            interval = cfg.poll_interval_ms / 1000.0

            reading = self._sensor.read()
            now = time.monotonic()

            if reading.provider == "unavailable":
                self._transition_to(ThermalState.SENSOR_UNAVAILABLE, cfg)
                self._update_status(reading, cfg, now)
                time.sleep(interval)
                continue

            temp = reading.cpu_temp

            # ── Update rolling window ──────────────────────────────────────
            if temp is not None:
                window_secs = cfg.rolling_avg_window_min * 60.0
                with self._window_lock:
                    self._window.append((now, temp))
                    # Evict entries outside window
                    while self._window and (now - self._window[0][0]) > window_secs:
                        self._window.popleft()
                self._session_temps.append(temp)
                if self._peak_temp is None or temp > self._peak_temp:
                    self._peak_temp = temp

            # ── Clock history for inferred throttle ───────────────────────
            if reading.effective_clock_mhz is not None:
                self._clock_history.append((now, reading.effective_clock_mhz))

            # ── Determine effective limit ──────────────────────────────────
            if cfg.monitor_only or cfg.selected_limit == -1:
                self._transition_to(ThermalState.MONITOR_ONLY, cfg)
                self._apply_delay(0.0)
                self._update_status(reading, cfg, now)
                time.sleep(interval)
                continue

            limit = self._effective_limit(cfg)
            rolling = self._rolling_avg()

            # ── Throttle detection ────────────────────────────────────────
            is_throttling = reading.is_throttling
            throttle_source = reading.throttle_source
            if is_throttling is None:
                # Infer from temp + clock drop
                is_throttling, throttle_source = self._infer_throttle(
                    temp, rolling, limit, cfg
                )

            self._track_throttle(is_throttling, now)

            # ── State machine ──────────────────────────────────────────────
            current = self._state
            new_state = self._next_state(
                current, temp, rolling, limit, is_throttling, cfg, now
            )
            if new_state != current:
                self._transition_to(new_state, cfg)

            # ── Apply delay ───────────────────────────────────────────────
            self._maybe_adjust_delay(new_state, is_throttling, cfg, now)

            # ── Update snapshot ───────────────────────────────────────────
            self._update_status(reading, cfg, now, rolling, is_throttling, throttle_source, limit)
            time.sleep(interval)

    # ------------------------------------------------------------------
    # State machine
    # ------------------------------------------------------------------

    def _next_state(
        self,
        current: ThermalState,
        temp: Optional[float],
        rolling: Optional[float],
        limit: float,
        is_throttling: Optional[bool],
        cfg: ThermalConfig,
        now: float,
    ) -> ThermalState:
        if temp is None and rolling is None:
            return current

        t = rolling if rolling is not None else temp
        time_in_state = now - self._state_entered_at

        if current == ThermalState.OPTIMAL:
            if t is not None and t > limit - 8:
                return ThermalState.WARM
            if is_throttling:
                return ThermalState.THROTTLING

        elif current == ThermalState.WARM:
            if t is not None and (t > limit - 3 or is_throttling):
                return ThermalState.COOLING
            if t is not None and t < limit - 12:
                return ThermalState.OPTIMAL

        elif current == ThermalState.COOLING:
            if is_throttling:
                return ThermalState.THROTTLING
            if t is not None and t < limit - 10 and time_in_state > 60:
                return ThermalState.RECOVERING

        elif current == ThermalState.THROTTLING:
            throttling_gone = not is_throttling
            time_since_throttle = (
                (now - self._last_throttle_end) if self._last_throttle_end else 0.0
            )
            if throttling_gone and time_since_throttle > 30 and t is not None and t < limit - 8:
                return ThermalState.RECOVERING

        elif current == ThermalState.RECOVERING:
            if is_throttling:
                return ThermalState.THROTTLING
            if t is not None and t < limit - 15 and time_in_state > 120:
                return ThermalState.OPTIMAL
            if t is not None and t > limit - 3:
                return ThermalState.COOLING

        elif current == ThermalState.SENSOR_UNAVAILABLE:
            return current  # handled above

        return current

    def _transition_to(self, new_state: ThermalState, cfg: ThermalConfig) -> None:
        old = self._state
        if new_state == old:
            return
        self._state = new_state
        self._state_entered_at = time.monotonic()
        msg = f"State: {old.value} -> {new_state.value}"
        logger.info("thermal_state_change", old=old.value, new=new_state.value)
        self._event_log.log(EVT_STATE_CHANGE, msg)

    # ------------------------------------------------------------------
    # Delay / pacing
    # ------------------------------------------------------------------

    def _maybe_adjust_delay(
        self,
        state: ThermalState,
        is_throttling: Optional[bool],
        cfg: ThermalConfig,
        now: float,
    ) -> None:
        too_soon = (now - self._last_adjustment) < cfg.min_time_between_adjustments_sec
        if too_soon:
            return

        base = self._STATE_DELAYS.get(state, 0.0)

        if is_throttling:
            new_delay = self._current_delay + cfg.throttle_backoff_step
            if new_delay != self._current_delay:
                self._event_log.log(
                    EVT_BACKOFF,
                    f"Throttle detected — delay {self._current_delay:.1f}s -> {new_delay:.1f}s",
                )
        elif state in (ThermalState.RECOVERING, ThermalState.OPTIMAL):
            new_delay = max(0.0, self._current_delay - cfg.recovery_step)
            if new_delay != self._current_delay:
                self._event_log.log(
                    EVT_RECOVERY,
                    f"Recovery — delay {self._current_delay:.1f}s -> {new_delay:.1f}s",
                )
        else:
            new_delay = base

        # Clamp to reasonable range
        new_delay = max(0.0, min(new_delay, 120.0))
        self._apply_delay(new_delay)

    def _apply_delay(self, delay: float) -> None:
        if delay == self._current_delay:
            return
        self._current_delay = delay
        self._last_adjustment = time.monotonic()
        try:
            self._worker.set_pacing(delay)
        except Exception as exc:
            logger.warning("set_pacing_error", error=str(exc))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _effective_limit(self, cfg: ThermalConfig) -> float:
        if cfg.auto_mode or cfg.selected_limit == 999:
            return self._auto_limit
        return cfg.selected_limit

    def _rolling_avg(self) -> Optional[float]:
        with self._window_lock:
            vals = [t for _, t in self._window]
        if not vals:
            return None
        return sum(vals) / len(vals)

    def _infer_throttle(
        self,
        temp: Optional[float],
        rolling: Optional[float],
        limit: float,
        cfg: ThermalConfig,
    ) -> Tuple[bool, str]:
        """Infer throttling from temp near limit + clock drop."""
        t = rolling if rolling is not None else temp
        if t is None:
            return False, "unknown"

        if t > limit - 2:
            # Check for clock drop >10% under sustained load
            if len(self._clock_history) >= 3:
                clocks = [c for _, c in self._clock_history]
                recent = clocks[-1]
                baseline = max(clocks[:-2])
                if baseline > 0 and (baseline - recent) / baseline > 0.10:
                    return True, "inferred"
            return True, "inferred"

        return False, "unknown"

    def _track_throttle(self, is_throttling: Optional[bool], now: float) -> None:
        if is_throttling:
            if self._throttle_start is None:
                self._throttle_start = now
                self._event_log.log(EVT_THROTTLE_START, "Throttling detected")
                logger.warning("thermal_throttle_start")
        else:
            if self._throttle_start is not None:
                duration = now - self._throttle_start
                self._total_throttle_sec += duration
                self._throttle_start = None
                self._last_throttle_end = now
                self._event_log.log(
                    EVT_THROTTLE_END,
                    f"Throttling ended after {duration:.1f}s",
                )

    def _update_status(
        self,
        reading: SensorReading,
        cfg: ThermalConfig,
        now: float,
        rolling: Optional[float] = None,
        is_throttling: Optional[bool] = None,
        throttle_source: str = "unknown",
        limit: float = 88.0,
    ) -> None:
        state = self._state

        session_avg = (
            sum(self._session_temps) / len(self._session_temps)
            if self._session_temps else None
        )

        throttle_sec = self._total_throttle_sec
        if self._throttle_start is not None:
            throttle_sec += now - self._throttle_start

        status_msg = self._status_message(state, reading.cpu_temp, rolling, limit, is_throttling)

        status = ThermalStatus(
            state=state.value,
            current_temp=reading.cpu_temp,
            rolling_avg=round(rolling, 1) if rolling is not None else None,
            session_avg=round(session_avg, 1) if session_avg is not None else None,
            peak_temp=self._peak_temp,
            cpu_load=reading.cpu_load,
            effective_clock_mhz=reading.effective_clock_mhz,
            is_throttling=is_throttling,
            throttle_source=throttle_source,
            provider=reading.provider,
            sensor_name=reading.sensor_name_used,
            time_throttling_sec=round(throttle_sec, 1),
            current_delay_sec=self._current_delay,
            auto_limit_effective=self._auto_limit,
            status_message=status_msg,
            last_update=datetime.utcnow().isoformat(),
            is_stale=reading.stale,
            config=cfg,
        )

        with self._status_lock:
            self._status = status

    def _status_message(
        self,
        state: ThermalState,
        temp: Optional[float],
        rolling: Optional[float],
        limit: float,
        is_throttling: Optional[bool],
    ) -> str:
        t = rolling or temp
        if state == ThermalState.OPTIMAL:
            return "Running at full speed"
        if state == ThermalState.WARM:
            return f"Warm ({t:.0f}°C) — monitoring" if t else "Warm — monitoring"
        if state == ThermalState.COOLING:
            return f"Reducing pacing to prevent throttling ({t:.0f}°C)" if t else "Reducing pacing to prevent throttling"
        if state == ThermalState.THROTTLING:
            return f"Throttling detected ({t:.0f}°C) — backing off" if t else "Throttling detected — backing off"
        if state == ThermalState.RECOVERING:
            return f"Recovering — gradually increasing speed ({t:.0f}°C)" if t else "Recovering — gradually increasing speed"
        if state == ThermalState.MONITOR_ONLY:
            return "Monitor-only mode — no pacing control"
        if state == ThermalState.SENSOR_UNAVAILABLE:
            return "Sensor unavailable — running at full speed"
        return "Unknown state"


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_controller: Optional[ThermalController] = None
_controller_lock = threading.Lock()


def get_thermal_controller() -> Optional[ThermalController]:
    global _controller
    with _controller_lock:
        return _controller


def create_thermal_controller(pipeline_worker: Any) -> ThermalController:
    global _controller
    with _controller_lock:
        if _controller is None:
            _controller = ThermalController(pipeline_worker)
        return _controller
