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
        on_hover: Callable[[tuple[int, int]], None] | None = None,
        drag_threshold_pixels: int = 12,
        hover_capture_enabled: bool = True,
        hover_delay_seconds: float = 0.8,
        hover_cooldown_seconds: float = 5.0,
        hover_min_move_pixels: int = 80,
        max_path_points: int = 240,
    ) -> None:
        self.on_selection = on_selection
        self.on_stop = on_stop
        self.on_hover = on_hover
        self.drag_threshold_pixels = drag_threshold_pixels
        self.hover_capture_enabled = hover_capture_enabled
        self.hover_delay_seconds = hover_delay_seconds
        self.hover_cooldown_seconds = hover_cooldown_seconds
        self.hover_min_move_pixels = hover_min_move_pixels
        self._path: deque[dict[str, Any]] = deque(maxlen=max_path_points)
        self._lock = threading.Lock()
        self._drag_start: tuple[int, int] | None = None
        self._position: tuple[int, int] | None = None
        self._last_move_at = 0.0
        self._last_hover_at = 0.0
        self._last_hover_position: tuple[int, int] | None = None
        self._mouse_listener = None
        self._keyboard_listener = None
        self._hover_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
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

            self._stop_event.clear()

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
                    with self._lock:
                        self._last_hover_at = time.monotonic()
                        self._last_hover_position = end_pos
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
            if self.on_hover:
                self._hover_thread = threading.Thread(target=self._hover_loop, daemon=True)
                self._hover_thread.start()
        except Exception as error:
            self._last_error = str(error)

    def stop(self) -> None:
        self._stop_event.set()
        for listener in (self._mouse_listener, self._keyboard_listener):
            try:
                if listener and listener.running:
                    listener.stop()
            except Exception as error:
                self._last_error = str(error)
        if self._hover_thread:
            self._hover_thread.join(timeout=1)

    def record_position(self, x: int, y: int) -> None:
        point = {"x": int(x), "y": int(y), "timestamp": time.time()}
        with self._lock:
            self._position = (int(x), int(y))
            self._last_move_at = time.monotonic()
            self._path.append(point)

    def current_position(self) -> tuple[int, int] | None:
        with self._lock:
            return self._position

    def recent_path(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._path)

    def _hover_loop(self) -> None:
        while not self._stop_event.is_set():
            hover_position = self._hover_candidate()
            if hover_position and self.on_hover:
                try:
                    self.on_hover(hover_position)
                except Exception as error:
                    self._last_error = str(error)
            time.sleep(0.1)

    def _hover_candidate(self) -> tuple[int, int] | None:
        now = time.monotonic()
        with self._lock:
            if not self.hover_capture_enabled or not self._position or self._drag_start is not None:
                return None
            if now - self._last_move_at < self.hover_delay_seconds:
                return None
            if now - self._last_hover_at < self.hover_cooldown_seconds:
                return None
            if self._last_hover_position and math.dist(self._position, self._last_hover_position) < self.hover_min_move_pixels:
                return None

            self._last_hover_at = now
            self._last_hover_position = self._position
            return self._position
