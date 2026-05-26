from __future__ import annotations

import os
import platform
import subprocess
from typing import Any


def availability() -> dict[str, Any]:
    return {"enabled": True, "available": True, "permission_required": False, "last_error": None}


def get_active_window_context() -> dict[str, Any]:
    system = platform.system().lower()
    try:
        if system == "windows":
            return _windows_active_window()
        if system == "darwin":
            return _mac_active_window()
        if system == "linux":
            return _linux_active_window()
    except Exception as error:
        return {"title": None, "app_name": None, "process_name": None, "pid": None, "bounds": None, "last_error": str(error)}

    return {"title": None, "app_name": None, "process_name": None, "pid": None, "bounds": None, "last_error": "Unsupported platform"}


def _process_name(pid: int | None) -> str | None:
    if not pid:
        return None
    try:
        import psutil
        return psutil.Process(pid).name()
    except Exception:
        return None


def _windows_active_window() -> dict[str, Any]:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, length + 1)

    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    process_name = _process_name(pid.value)

    return {
        "title": buffer.value,
        "app_name": process_name,
        "process_name": process_name,
        "pid": int(pid.value) if pid.value else None,
        "bounds": {"left": rect.left, "top": rect.top, "right": rect.right, "bottom": rect.bottom},
        "last_error": None,
    }


def _mac_active_window() -> dict[str, Any]:
    script = (
        'tell application "System Events"\n'
        'set frontApp to first application process whose frontmost is true\n'
        'set appName to name of frontApp\n'
        'set winTitle to ""\n'
        'try\n'
        'set winTitle to name of front window of frontApp\n'
        'end try\n'
        'return appName & "\n" & winTitle\n'
        'end tell'
    )
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=2, check=False)
    lines = result.stdout.splitlines()
    app_name = lines[0] if lines else None
    title = lines[1] if len(lines) > 1 else None
    return {"title": title, "app_name": app_name, "process_name": app_name, "pid": None, "bounds": None, "last_error": result.stderr.strip() or None}


def _linux_active_window() -> dict[str, Any]:
    if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        return {
            "title": None,
            "app_name": None,
            "process_name": None,
            "pid": None,
            "bounds": None,
            "last_error": "Wayland restricts active-window queries for many apps.",
        }

    window_id = subprocess.run(["xdotool", "getactivewindow"], capture_output=True, text=True, timeout=1, check=False)
    wid = window_id.stdout.strip()
    title = subprocess.run(["xdotool", "getwindowname", wid], capture_output=True, text=True, timeout=1, check=False) if wid else None
    pid_result = subprocess.run(["xdotool", "getwindowpid", wid], capture_output=True, text=True, timeout=1, check=False) if wid else None
    pid = int(pid_result.stdout.strip()) if pid_result and pid_result.stdout.strip().isdigit() else None
    process_name = _process_name(pid)
    return {
        "title": title.stdout.strip() if title and title.returncode == 0 else None,
        "app_name": process_name,
        "process_name": process_name,
        "pid": pid,
        "bounds": None,
        "last_error": None,
    }
