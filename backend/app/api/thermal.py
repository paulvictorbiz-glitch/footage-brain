"""
Thermal monitoring API.

Endpoints:
  GET  /thermal/status   — current thermal status snapshot
  GET  /thermal/events   — recent thermal events
  GET  /thermal/config   — current ThermalConfig
  POST /thermal/config   — update ThermalConfig (partial)
  POST /thermal/batch    — set batch size on the pipeline worker
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.ingest.pipeline import get_pipeline_worker
from app.thermal.controller import ThermalConfig, ThermalStatus, get_thermal_controller

router = APIRouter(prefix="/thermal", tags=["thermal"])


# ---------------------------------------------------------------------------
# Pydantic response/request models
# ---------------------------------------------------------------------------

class ThermalConfigSchema(BaseModel):
    selected_limit: float
    auto_mode: bool
    poll_interval_ms: int
    rolling_avg_window_min: float
    cooldown_threshold_c: float
    resume_threshold_c: float
    throttle_backoff_step: float
    recovery_step: float
    min_time_between_adjustments_sec: int
    default_batch_size: int
    monitor_only: bool

    @classmethod
    def from_dataclass(cls, cfg: ThermalConfig) -> "ThermalConfigSchema":
        return cls(
            selected_limit=cfg.selected_limit,
            auto_mode=cfg.auto_mode,
            poll_interval_ms=cfg.poll_interval_ms,
            rolling_avg_window_min=cfg.rolling_avg_window_min,
            cooldown_threshold_c=cfg.cooldown_threshold_c,
            resume_threshold_c=cfg.resume_threshold_c,
            throttle_backoff_step=cfg.throttle_backoff_step,
            recovery_step=cfg.recovery_step,
            min_time_between_adjustments_sec=cfg.min_time_between_adjustments_sec,
            default_batch_size=cfg.default_batch_size,
            monitor_only=cfg.monitor_only,
        )


class ThermalStatusResponse(BaseModel):
    state: str
    current_temp: Optional[float]
    rolling_avg: Optional[float]
    session_avg: Optional[float]
    peak_temp: Optional[float]
    cpu_load: Optional[float]
    effective_clock_mhz: Optional[float]
    is_throttling: Optional[bool]
    throttle_source: str
    provider: str
    sensor_name: str
    time_throttling_sec: float
    current_delay_sec: float
    auto_limit_effective: float
    status_message: str
    last_update: Optional[str]
    is_stale: bool
    config: ThermalConfigSchema


class ThermalEventSchema(BaseModel):
    timestamp: str
    event_type: str
    message: str
    temp: Optional[float]


class ThermalEventsResponse(BaseModel):
    events: List[ThermalEventSchema]


class ThermalConfigUpdateRequest(BaseModel):
    selected_limit: Optional[float] = None
    auto_mode: Optional[bool] = None
    poll_interval_ms: Optional[int] = None
    rolling_avg_window_min: Optional[float] = None
    cooldown_threshold_c: Optional[float] = None
    resume_threshold_c: Optional[float] = None
    throttle_backoff_step: Optional[float] = None
    recovery_step: Optional[float] = None
    min_time_between_adjustments_sec: Optional[int] = None
    default_batch_size: Optional[int] = None
    monitor_only: Optional[bool] = None


class BatchSizeRequest(BaseModel):
    batch_size: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_controller():
    ctrl = get_thermal_controller()
    if ctrl is None:
        raise HTTPException(status_code=503, detail="Thermal controller not initialized")
    return ctrl


def _status_to_response(status: ThermalStatus) -> ThermalStatusResponse:
    cfg_schema = ThermalConfigSchema.from_dataclass(
        status.config if status.config is not None else ThermalConfig()
    )
    return ThermalStatusResponse(
        state=status.state,
        current_temp=status.current_temp,
        rolling_avg=status.rolling_avg,
        session_avg=status.session_avg,
        peak_temp=status.peak_temp,
        cpu_load=status.cpu_load,
        effective_clock_mhz=status.effective_clock_mhz,
        is_throttling=status.is_throttling,
        throttle_source=status.throttle_source,
        provider=status.provider,
        sensor_name=status.sensor_name,
        time_throttling_sec=status.time_throttling_sec,
        current_delay_sec=status.current_delay_sec,
        auto_limit_effective=status.auto_limit_effective,
        status_message=status.status_message,
        last_update=status.last_update,
        is_stale=status.is_stale,
        config=cfg_schema,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/status", response_model=ThermalStatusResponse)
def get_thermal_status():
    """Return the current thermal status snapshot."""
    ctrl = _require_controller()
    status = ctrl.get_status()
    return _status_to_response(status)


@router.get("/events", response_model=ThermalEventsResponse)
def get_thermal_events(n: int = Query(default=50, ge=1, le=200)):
    """Return the last N thermal events."""
    from app.thermal.events import get_event_logger
    log = get_event_logger()
    events = log.get_last(n)
    return ThermalEventsResponse(
        events=[
            ThermalEventSchema(
                timestamp=e.timestamp.isoformat(),
                event_type=e.event_type,
                message=e.message,
                temp=e.temp,
            )
            for e in reversed(events)  # newest first
        ]
    )


@router.get("/config", response_model=ThermalConfigSchema)
def get_thermal_config():
    """Return the current thermal configuration."""
    ctrl = _require_controller()
    return ThermalConfigSchema.from_dataclass(ctrl.get_config())


@router.post("/config", response_model=ThermalConfigSchema)
def update_thermal_config(body: ThermalConfigUpdateRequest):
    """Update thermal configuration (partial update — only provided fields)."""
    ctrl = _require_controller()
    updates: Dict[str, Any] = {
        k: v for k, v in body.dict().items() if v is not None
    }
    if not updates:
        return ThermalConfigSchema.from_dataclass(ctrl.get_config())
    cfg = ctrl.update_config(updates)
    return ThermalConfigSchema.from_dataclass(cfg)


@router.post("/batch")
def set_batch_size(body: BatchSizeRequest):
    """Set the pipeline batch limit (0 = unlimited)."""
    worker = get_pipeline_worker()
    worker.set_batch_limit(body.batch_size)
    return {"batch_size": body.batch_size}
