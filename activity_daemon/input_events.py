from __future__ import annotations

from collections import deque
import math
import threading
import time
from typing import Any, Callable


class InputEventCollector:
    def __init__(
        self,
        on_selection: Callable[[tuple[int, int], tuple[int, int]], None],
        on_stop: Callable[[], None],
        drag_threshold_pixels: int = 12,
        max_path_points: int = 240,
    ) -> None:
        self.on_selection = on_selection
        self.on_stop = on_stop
        self.drag_threshold_pixels = drag_threshold_pixels
        self._path: deque[dict[str, Any]] = deque(maxlen=max_path_points)
        self._lock = threading.Lock()
        self._drag_start: tuple[int, int] | None = None
        self._position: tuple[int, int] | None = None
        self._mouse_listener = None
        self._keyboard_listener = None
        self._last_error: str | None = None

    def availability(self) -> dict[str, Any]:
        try:
            import pynput  # noqa: F401
            return {"enabled": True, "available": True, "permission_required": False, "last_error": self._last_error}
        except Exception as error:
            return {"enabled": True, "available": False, "permission_required": False, "last_error": str(error)}

    def start(self) -> None:
        try:
            from pynput import keyboard, mouse

            def on_move(x: int, y: int) -> None:
                self.record_position(x, y)

            def on_click(x: int, y: int, button: Any, pressed: bool) -> None:
                if button != mouse.Button.left:
                    return
                self.record_position(x, y)
                if pressed:
                    self._drag_start = (x, y)
                    return
                if self._drag_start is None:
                    return
                start_pos = self._drag_start
                end_pos = (x, y)
                self._drag_start = None
                if math.dist(start_pos, end_pos) >= self.drag_threshold_pixels:
                    self.on_selection(start_pos, end_pos)

            def on_key_press(key: Any) -> bool | None:
                if key == keyboard.Key.esc:
                    self.on_stop()
                    return False
                return None

            self._mouse_listener = mouse.Listener(on_move=on_move, on_click=on_click)
            self._keyboard_listener = keyboard.Listener(on_press=on_key_press)
            self._mouse_listener.start()
            self._keyboard_listener.start()
        except Exception as error:
            self._last_error = str(error)

    def stop(self) -> None:
        for listener in (self._mouse_listener, self._keyboard_listener):
            try:
                if listener and listener.running:
                    listener.stop()
            except Exception as error:
                self._last_error = str(error)

    def record_position(self, x: int, y: int) -> None:
        point = {"x": int(x), "y": int(y), "timestamp": time.time()}
        with self._lock:
            self._position = (int(x), int(y))
            self._path.append(point)

    def current_position(self) -> tuple[int, int] | None:
        with self._lock:
            return self._position

    def recent_path(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._path)
