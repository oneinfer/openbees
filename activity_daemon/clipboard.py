from __future__ import annotations

import platform
import subprocess
import threading
import time
from typing import Any
import uuid


class ClipboardCollector:
    def __init__(self, poll_seconds: float = 0.5) -> None:
        self.poll_seconds = poll_seconds
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._clipboard_text = ""
        self._primary_selection_text = ""
        self._last_error: str | None = None

    def availability(self) -> dict[str, Any]:
        try:
            import pyperclip  # noqa: F401
            return {"enabled": True, "available": True, "permission_required": False, "last_error": self._last_error}
        except Exception as error:
            return {"enabled": True, "available": False, "permission_required": False, "last_error": str(error)}

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "clipboard_text": self._clipboard_text,
                "primary_selection_text": self._primary_selection_text,
            }

    def capture_selected_text_via_copy(
        self,
        timeout_seconds: float = 0.8,
        preserve_clipboard: bool = True,
    ) -> dict[str, Any]:
        original_text = self._read_clipboard()
        sentinel = f"__oneinfer_selection_probe_{uuid.uuid4()}__"
        copied_text = ""
        error = None
        clipboard_restored = False

        try:
            self._write_clipboard(sentinel)
            self._send_copy_shortcut()
            deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < deadline:
                value = self._read_clipboard()
                if value is not None and value != sentinel:
                    copied_text = value
                    break
                time.sleep(0.05)
            if not copied_text and platform.system().lower() == "windows":
                self._write_clipboard(sentinel)
                self._send_copy_shortcut(use_shift=True)
                deadline = time.monotonic() + timeout_seconds
                while time.monotonic() < deadline:
                    value = self._read_clipboard()
                    if value is not None and value != sentinel:
                        copied_text = value
                        break
                    time.sleep(0.05)
        except Exception as exc:
            error = str(exc)
            self._last_error = error
        finally:
            if original_text is not None and (preserve_clipboard or not copied_text):
                self._write_clipboard(original_text)
                clipboard_restored = True

        if copied_text:
            with self._lock:
                self._clipboard_text = copied_text

        return {
            "selection_text": copied_text,
            "method": "keyboard_copy",
            "clipboard_restored": clipboard_restored,
            "last_error": error,
        }

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            self.refresh()
            time.sleep(self.poll_seconds)

    def refresh(self) -> None:
        clipboard_text = self._read_clipboard()
        primary_text = self._read_linux_primary_selection()
        with self._lock:
            if clipboard_text is not None:
                self._clipboard_text = clipboard_text
            if primary_text is not None:
                self._primary_selection_text = primary_text

    def _read_clipboard(self) -> str | None:
        try:
            import pyperclip
            value = pyperclip.paste()
            return value if isinstance(value, str) else ""
        except Exception as error:
            self._last_error = str(error)
            return None

    def _write_clipboard(self, value: str) -> None:
        try:
            import pyperclip
            pyperclip.copy(value)
        except Exception as error:
            self._last_error = str(error)

    def _send_copy_shortcut(self, use_shift: bool = False) -> None:
        from pynput.keyboard import Controller, Key

        keyboard = Controller()
        modifier = Key.cmd if platform.system().lower() == "darwin" else Key.ctrl
        time.sleep(0.08)
        if use_shift:
            with keyboard.pressed(modifier):
                with keyboard.pressed(Key.shift):
                    keyboard.press("c")
                    time.sleep(0.03)
                    keyboard.release("c")
            return
        with keyboard.pressed(modifier):
            keyboard.press("c")
            time.sleep(0.03)
            keyboard.release("c")

    def _read_linux_primary_selection(self) -> str | None:
        if platform.system().lower() != "linux":
            return None
        try:
            result = subprocess.run(
                ["xdotool", "getwindowfocus"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=0.5,
                check=False,
            )
            if result.returncode != 0:
                return None
            selection = subprocess.run(
                ["xclip", "-selection", "primary", "-o"],
                capture_output=True,
                text=True,
                timeout=0.5,
                check=False,
            )
            return selection.stdout if selection.returncode == 0 else None
        except Exception:
            return None
