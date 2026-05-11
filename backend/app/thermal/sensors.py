"""
Thermal sensor abstraction layer.

Provides CPU temperature, load, clock speed and throttle detection via:
 - HWiNFO64 shared-memory interface (Global\\HWiNFO_SENS_SM2)
 - LibreHardwareMonitor WMI namespace (via PowerShell subprocess)
 - Unavailable fallback

No third-party packages required: uses ctypes for HWiNFO, subprocess for LHM.
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes
import json
import struct
import subprocess
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from app.core.logging import get_logger

logger = get_logger(__name__)

# ---------------------------------------------------------------------------
# SensorReading dataclass
# ---------------------------------------------------------------------------

@dataclass
class SensorReading:
    cpu_temp: Optional[float] = None
    cpu_load: Optional[float] = None
    effective_clock_mhz: Optional[float] = None
    is_throttling: Optional[bool] = None
    throttle_source: str = "unknown"      # "direct" | "inferred" | "unknown"
    provider: str = "unavailable"         # "hwinfo" | "lhm" | "unavailable"
    timestamp: datetime = field(default_factory=datetime.utcnow)
    sensor_name_used: str = ""

    @property
    def stale(self) -> bool:
        return (datetime.utcnow() - self.timestamp).total_seconds() > 30


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------

class SensorProvider(ABC):
    @abstractmethod
    def read(self) -> SensorReading:
        ...

    @abstractmethod
    def is_available(self) -> bool:
        ...

    @abstractmethod
    def name(self) -> str:
        ...


# ---------------------------------------------------------------------------
# HWiNFO shared-memory layout constants
# ---------------------------------------------------------------------------

HWINFO_SM_NAME = "Global\\HWiNFO_SENS_SM2"

# Header (little-endian packed):  sig(4s) ver(I) rev(I) poll_time(q)
#   sensor_offset(I) sensor_size(I) sensor_count(I)
#   reading_offset(I) reading_size(I) reading_count(I)
HEADER_FMT = "<4sIIqIIIIII"
HEADER_SIZE = struct.calcsize(HEADER_FMT)   # 44 bytes

SENSOR_FMT  = "<II128s128s"
SENSOR_SIZE = struct.calcsize(SENSOR_FMT)   # 264 bytes

READING_FMT  = "<III128s128s16sdddd"
READING_SIZE = struct.calcsize(READING_FMT) # 312 bytes

READING_TYPE_TEMP  = 1
READING_TYPE_CLOCK = 6
READING_TYPE_USAGE = 7


class HWiNFOProvider(SensorProvider):
    """Reads HWiNFO64 shared memory without any extra packages."""

    def name(self) -> str:
        return "hwinfo"

    def is_available(self) -> bool:
        # Actually attempt a read — opening the handle alone is insufficient
        # because HWiNFO can create the mapping without committing pages.
        try:
            result = self._do_read()
            return result.provider == "hwinfo"
        except Exception:
            return False

    def _open_shm(self):
        """Open HWiNFO shared memory; return handle or None."""
        try:
            FILE_MAP_READ = 0x0004
            handle = ctypes.windll.kernel32.OpenFileMappingW(
                FILE_MAP_READ, False, HWINFO_SM_NAME
            )
            return handle if handle else None
        except Exception:
            return None

    def _map_view(self, handle):
        """Map the shared-memory file; returns address or 0."""
        try:
            addr = ctypes.windll.kernel32.MapViewOfFile(handle, 0x0004, 0, 0, 0)
            return addr
        except Exception:
            return 0

    def _read_raw(self, addr: int, offset: int, size: int) -> bytes:
        # ctypes.string_at is safer than memmove for mapped memory
        return ctypes.string_at(addr + offset, size)

    def read(self) -> SensorReading:
        try:
            return self._do_read()
        except Exception as exc:
            logger.debug("hwinfo_read_error", error=str(exc))
            return SensorReading(provider="unavailable")

    def _do_read(self) -> SensorReading:
        handle = self._open_shm()
        if not handle:
            return SensorReading(provider="unavailable")

        try:
            addr = self._map_view(handle)
            if not addr:
                return SensorReading(provider="unavailable")

            try:
                raw_header = self._read_raw(addr, 0, HEADER_SIZE)
                (sig, ver, rev, poll_time,
                 sensor_offset, sensor_size, sensor_count,
                 reading_offset, reading_size, reading_count) = struct.unpack(HEADER_FMT, raw_header)

                if sig != b"HWiS":
                    return SensorReading(provider="unavailable")

                # Parse sensors (build index: sensor_index -> name)
                sensor_names: dict[int, str] = {}
                for i in range(sensor_count):
                    raw = self._read_raw(addr, sensor_offset + i * sensor_size, SENSOR_SIZE)
                    sensor_id, sensor_inst, name_orig_b, name_user_b = struct.unpack(SENSOR_FMT, raw)
                    name = name_user_b.split(b"\x00")[0].decode("utf-8", errors="replace").strip()
                    if not name:
                        name = name_orig_b.split(b"\x00")[0].decode("utf-8", errors="replace").strip()
                    sensor_names[i] = name

                # Parse readings
                cpu_temp: Optional[float] = None
                cpu_load: Optional[float] = None
                clock_mhz: Optional[float] = None
                is_throttling: Optional[bool] = None
                throttle_source = "unknown"
                best_sensor_name = ""

                for i in range(reading_count):
                    raw = self._read_raw(addr, reading_offset + i * reading_size, READING_SIZE)
                    (rtype, sensor_idx, reading_id,
                     label_orig_b, label_user_b,
                     unit_b,
                     value, val_min, val_max, val_avg) = struct.unpack(READING_FMT, raw)

                    label = label_user_b.split(b"\x00")[0].decode("utf-8", errors="replace").strip()
                    if not label:
                        label = label_orig_b.split(b"\x00")[0].decode("utf-8", errors="replace").strip()

                    label_lo = label.lower()
                    sensor_name = sensor_names.get(sensor_idx, "")
                    sensor_lo = sensor_name.lower()

                    # CPU Temperature
                    if rtype == READING_TYPE_TEMP and cpu_temp is None:
                        is_pkg = any(k in label_lo for k in ("package", "die", "core"))
                        is_cpu = "cpu" in sensor_lo
                        if is_pkg and is_cpu:
                            cpu_temp = value
                            best_sensor_name = sensor_name

                    # CPU Usage
                    if rtype == READING_TYPE_USAGE and cpu_load is None:
                        if "cpu" in label_lo and ("usage" in label_lo or "total" in label_lo):
                            cpu_load = value

                    # Effective / CPU clock
                    if rtype == READING_TYPE_CLOCK and clock_mhz is None:
                        if "effective" in label_lo or ("cpu" in label_lo and "clock" in label_lo):
                            clock_mhz = value

                    # Throttle flags
                    if any(k in label_lo for k in ("prochot", "thermal", "performance limit")):
                        if rtype == READING_TYPE_USAGE:
                            if is_throttling is None:
                                is_throttling = bool(value > 0)
                                throttle_source = "direct"

                return SensorReading(
                    cpu_temp=cpu_temp,
                    cpu_load=cpu_load,
                    effective_clock_mhz=clock_mhz,
                    is_throttling=is_throttling,
                    throttle_source=throttle_source if is_throttling is not None else "unknown",
                    provider="hwinfo",
                    timestamp=datetime.utcnow(),
                    sensor_name_used=best_sensor_name,
                )
            finally:
                ctypes.windll.kernel32.UnmapViewOfFile(ctypes.c_void_p(addr))
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)


# ---------------------------------------------------------------------------
# nvidia-smi Provider (GPU temperature — always available when CUDA is present)
# ---------------------------------------------------------------------------

class NvidiaSmiProvider(SensorProvider):
    """Reads GPU temperature + utilization via nvidia-smi subprocess."""

    def name(self) -> str:
        return "nvidia-smi"

    def is_available(self) -> bool:
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=5
            )
            return r.returncode == 0 and r.stdout.strip().isdigit()
        except Exception:
            return False

    def read(self) -> SensorReading:
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=temperature.gpu,utilization.gpu,clocks.current.graphics",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5
            )
            if r.returncode != 0:
                return SensorReading(provider="unavailable")
            parts = [p.strip() for p in r.stdout.strip().split(",")]
            gpu_temp = float(parts[0]) if parts[0].isdigit() else None
            gpu_load = float(parts[1]) if len(parts) > 1 and parts[1].replace('.', '').isdigit() else None
            clock_mhz = float(parts[2]) if len(parts) > 2 and parts[2].replace('.', '').isdigit() else None
            if gpu_temp is None:
                return SensorReading(provider="unavailable")
            return SensorReading(
                cpu_temp=gpu_temp,
                cpu_load=gpu_load,
                effective_clock_mhz=clock_mhz,
                is_throttling=None,
                throttle_source="unknown",
                provider="nvidia-smi",
                timestamp=datetime.utcnow(),
                sensor_name_used="GPU",
            )
        except Exception as exc:
            logger.debug("nvidia_smi_error", error=str(exc))
            return SensorReading(provider="unavailable")


# ---------------------------------------------------------------------------
# LHM Provider (LibreHardwareMonitor via PowerShell WMI)
# ---------------------------------------------------------------------------

_LHM_TEMP_CMD = (
    'powershell -NonInteractive -Command "'
    'Get-WmiObject -Namespace root\\LibreHardwareMonitor -Class Sensor '
    '-ErrorAction SilentlyContinue | '
    "Where-Object {$_.SensorType -eq 'Temperature' -and $_.Name -match 'CPU'} | "
    'Select-Object Name,Value,Hardware | ConvertTo-Json -Compress 2>$null"'
)

_LHM_CLOCK_CMD = (
    'powershell -NonInteractive -Command "'
    'Get-WmiObject -Namespace root\\LibreHardwareMonitor -Class Sensor '
    '-ErrorAction SilentlyContinue | '
    "Where-Object {$_.SensorType -eq 'Clock' -and $_.Name -match 'CPU'} | "
    'Select-Object Name,Value,Hardware | ConvertTo-Json -Compress 2>$null"'
)


class LHMProvider(SensorProvider):
    """Reads LibreHardwareMonitor via WMI using PowerShell subprocess."""

    def name(self) -> str:
        return "lhm"

    def is_available(self) -> bool:
        try:
            result = subprocess.run(
                _LHM_TEMP_CMD, shell=True, capture_output=True, text=True, timeout=5
            )
            out = result.stdout.strip()
            return bool(out and out not in ("null", "[]", ""))
        except Exception:
            return False

    def _run_ps(self, cmd: str, timeout: int = 8) -> Optional[list]:
        try:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=timeout
            )
            out = result.stdout.strip()
            if not out or out in ("null", "[]", ""):
                return None
            parsed = json.loads(out)
            if isinstance(parsed, dict):
                return [parsed]
            return parsed
        except Exception as exc:
            logger.debug("lhm_ps_error", error=str(exc))
            return None

    def read(self) -> SensorReading:
        try:
            return self._do_read()
        except Exception as exc:
            logger.debug("lhm_read_error", error=str(exc))
            return SensorReading(provider="unavailable")

    def _do_read(self) -> SensorReading:
        temp_rows = self._run_ps(_LHM_TEMP_CMD)
        clock_rows = self._run_ps(_LHM_CLOCK_CMD)

        cpu_temp: Optional[float] = None
        clock_mhz: Optional[float] = None
        sensor_name = ""

        if temp_rows:
            # Prefer "CPU Package" then any CPU temp
            best = None
            for row in temp_rows:
                name = str(row.get("Name", "")).lower()
                val = row.get("Value")
                if val is None:
                    continue
                if "package" in name and best is None:
                    best = (val, str(row.get("Name", "")))
                elif best is None:
                    best = (val, str(row.get("Name", "")))
            if best:
                cpu_temp = float(best[0])
                sensor_name = best[1]

        if clock_rows:
            # Prefer "Effective" clock
            for row in clock_rows:
                name = str(row.get("Name", "")).lower()
                val = row.get("Value")
                if val is None:
                    continue
                if "effective" in name:
                    clock_mhz = float(val)
                    break
            if clock_mhz is None and clock_rows:
                val = clock_rows[0].get("Value")
                if val is not None:
                    clock_mhz = float(val)

        if cpu_temp is None:
            return SensorReading(provider="unavailable")

        return SensorReading(
            cpu_temp=cpu_temp,
            cpu_load=None,  # LHM load not queried here (expensive)
            effective_clock_mhz=clock_mhz,
            is_throttling=None,
            throttle_source="unknown",
            provider="lhm",
            timestamp=datetime.utcnow(),
            sensor_name_used=sensor_name,
        )


# ---------------------------------------------------------------------------
# Composite provider (HWiNFO first, fallback to LHM)
# ---------------------------------------------------------------------------

class CompositeSensorProvider(SensorProvider):
    """Thread-safe composite that tries HWiNFO first, then LHM."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: Optional[SensorProvider] = None
        self._providers: list[SensorProvider] = [HWiNFOProvider(), LHMProvider(), NvidiaSmiProvider()]
        self._last_probe = 0.0
        self._probe_interval = 30.0  # re-probe availability every 30s

    def name(self) -> str:
        with self._lock:
            return self._active.name() if self._active else "unavailable"

    def is_available(self) -> bool:
        return self._get_provider() is not None

    def _get_provider(self) -> Optional[SensorProvider]:
        now = time.monotonic()
        with self._lock:
            if self._active is not None and (now - self._last_probe) < self._probe_interval:
                return self._active

        # Re-probe (outside lock to avoid blocking)
        chosen = None
        for p in self._providers:
            try:
                if p.is_available():
                    chosen = p
                    break
            except Exception as exc:
                logger.debug("sensor_probe_error", provider=p.name(), error=str(exc))

        with self._lock:
            old = self._active
            self._active = chosen
            self._last_probe = now
            if chosen != old:
                logger.info(
                    "sensor_provider_changed",
                    old=old.name() if old else "none",
                    new=chosen.name() if chosen else "unavailable",
                )
        return chosen

    def read(self) -> SensorReading:
        provider = self._get_provider()
        if provider is None:
            return SensorReading(provider="unavailable", timestamp=datetime.utcnow())
        try:
            result = provider.read()
            if result.provider == "unavailable":
                # Force re-probe next time
                with self._lock:
                    self._last_probe = 0.0
            return result
        except Exception as exc:
            logger.warning("sensor_read_error", provider=provider.name(), error=str(exc))
            with self._lock:
                self._last_probe = 0.0
            return SensorReading(provider="unavailable", timestamp=datetime.utcnow())


# Singleton
_composite: Optional[CompositeSensorProvider] = None
_composite_lock = threading.Lock()


def get_sensor_provider() -> CompositeSensorProvider:
    global _composite
    with _composite_lock:
        if _composite is None:
            _composite = CompositeSensorProvider()
    return _composite
