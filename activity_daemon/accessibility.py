from __future__ import annotations

import os
import platform
import subprocess
from typing import Any


class AccessibilityCollector:
    def __init__(self) -> None:
        self._last_error: str | None = None

    def availability(self) -> dict[str, Any]:
        system = platform.system().lower()
        if system == "windows":
            try:
                import pywinauto  # noqa: F401
                return {"enabled": True, "available": True, "permission_required": False, "last_error": self._last_error}
            except Exception as error:
                return {"enabled": True, "available": False, "permission_required": False, "last_error": str(error)}
        if system == "darwin":
            allowed = self._mac_accessibility_allowed()
            return {"enabled": True, "available": allowed, "permission_required": not allowed, "last_error": self._last_error}
        if system == "linux":
            if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
                return {
                    "enabled": True,
                    "available": False,
                    "permission_required": True,
                    "last_error": "Wayland may block global accessibility queries.",
                }
            try:
                import pyatspi  # noqa: F401
                return {"enabled": True, "available": True, "permission_required": False, "last_error": self._last_error}
            except Exception as error:
                return {"enabled": True, "available": False, "permission_required": False, "last_error": str(error)}
        return {"enabled": True, "available": False, "permission_required": False, "last_error": "Unsupported platform"}

    def snapshot(self) -> dict[str, Any]:
        system = platform.system().lower()
        try:
            if system == "windows":
                return self._windows_snapshot()
            if system == "darwin":
                return self._mac_snapshot()
            if system == "linux":
                return self._linux_snapshot()
        except Exception as error:
            self._last_error = str(error)
            return {"hover_text": "", "focused_text": "", "last_error": str(error)}
        return {"hover_text": "", "focused_text": "", "last_error": "Unsupported platform"}

    def _windows_snapshot(self) -> dict[str, Any]:
        from pywinauto import Desktop

        desktop = Desktop(backend="uia")
        focused = desktop.get_focus()
        focused_text = _element_text(focused)
        hover_text = ""
        try:
            hover_text = _element_text(desktop.from_point())
        except Exception:
            pass
        return {"hover_text": hover_text, "focused_text": focused_text, "last_error": None}

    def _mac_accessibility_allowed(self) -> bool:
        script = 'tell application "System Events" to return UI elements enabled'
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=2, check=False)
        if result.returncode != 0:
            self._last_error = result.stderr.strip() or "Accessibility permission is not available."
            return False
        return result.stdout.strip().lower() == "true"

    def _mac_snapshot(self) -> dict[str, Any]:
        if not self._mac_accessibility_allowed():
            return {"hover_text": "", "focused_text": "", "last_error": self._last_error}
        script = (
            'tell application "System Events"\n'
            'set frontApp to first application process whose frontmost is true\n'
            'set focusedText to ""\n'
            'try\n'
            'set focusedText to value of focused UI element of frontApp as text\n'
            'end try\n'
            'return focusedText\n'
            'end tell'
        )
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=2, check=False)
        return {"hover_text": "", "focused_text": result.stdout.strip(), "last_error": result.stderr.strip() or None}

    def _linux_snapshot(self) -> dict[str, Any]:
        import pyatspi

        desktop = pyatspi.Registry.getDesktop(0)
        focused_text = ""
        for app_index in range(desktop.childCount):
            app = desktop.getChildAtIndex(app_index)
            focused_text = _linux_find_focused_text(app)
            if focused_text:
                break
        return {"hover_text": "", "focused_text": focused_text, "last_error": None}


def _element_text(element: Any) -> str:
    candidates = []
    for attr in ("window_text", "texts"):
        try:
            value = getattr(element, attr)()
            if isinstance(value, list):
                candidates.extend(str(item) for item in value if item)
            elif value:
                candidates.append(str(value))
        except Exception:
            pass
    for attr in ("element_info",):
        try:
            info = getattr(element, attr)
            for field in ("name", "rich_text", "control_type"):
                value = getattr(info, field, None)
                if value:
                    candidates.append(str(value))
        except Exception:
            pass
    return " ".join(dict.fromkeys(item.strip() for item in candidates if item.strip()))


def _linux_find_focused_text(node: Any, depth: int = 0) -> str:
    if depth > 6:
        return ""
    try:
        state = node.getState()
        if state.contains(7):  # pyatspi.STATE_FOCUSED
            text = node.queryText()
            return text.getText(0, text.characterCount)
    except Exception:
        pass
    try:
        for index in range(node.childCount):
            value = _linux_find_focused_text(node.getChildAtIndex(index), depth + 1)
            if value:
                return value
    except Exception:
        pass
    return ""
