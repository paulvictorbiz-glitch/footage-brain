"""
Thermal event logger — thread-safe ring buffer for thermal system events.
"""
from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

# ---------------------------------------------------------------------------
# Event types (constants for convenience)
# ---------------------------------------------------------------------------

EVT_THROTTLE_START    = "throttle_start"
EVT_THROTTLE_END      = "throttle_end"
EVT_BACKOFF           = "backoff"
EVT_RECOVERY          = "recovery"
EVT_SENSOR_SWITCH     = "sensor_switch"
EVT_SENSOR_FAIL       = "sensor_fail"
EVT_THRESHOLD_CROSSED = "threshold_crossed"
EVT_STATE_CHANGE      = "state_change"


@dataclass
class ThermalEvent:
    timestamp: datetime
    event_type: str
    message: str
    temp: Optional[float] = None


class EventLogger:
    """Thread-safe ring buffer for thermal events (max 200 entries)."""

    MAX_EVENTS = 200

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buffer: deque[ThermalEvent] = deque(maxlen=self.MAX_EVENTS)

    def log(
        self,
        event_type: str,
        message: str,
        temp: Optional[float] = None,
    ) -> None:
        event = ThermalEvent(
            timestamp=datetime.utcnow(),
            event_type=event_type,
            message=message,
            temp=temp,
        )
        with self._lock:
            self._buffer.append(event)

    def get_all(self) -> List[ThermalEvent]:
        with self._lock:
            return list(self._buffer)

    def get_last(self, n: int) -> List[ThermalEvent]:
        with self._lock:
            items = list(self._buffer)
        return items[-n:] if n < len(items) else items

    def clear(self) -> None:
        with self._lock:
            self._buffer.clear()


# Singleton
_logger: Optional[EventLogger] = None
_logger_lock = threading.Lock()


def get_event_logger() -> EventLogger:
    global _logger
    with _logger_lock:
        if _logger is None:
            _logger = EventLogger()
    return _logger
