from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import platform
import queue
import re
import signal
import shutil
import sys
import threading
import time
import uuid
from pathlib import Path
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .accessibility import AccessibilityCollector
from .capture import ScreenCapture
from .clipboard import ClipboardCollector
from .config import ActivityConfig, load_config, save_config
from .input_events import InputEventCollector
from .store import ActivityStore, build_context_payload
from .window_context import availability as window_availability
from .window_context import get_active_window_context


CAPTURE_CONTEXT_WORDS = {
    "above",
    "below",
    "current",
    "cursor",
    "here",
    "highlight",
    "highlighted",
    "image",
    "page",
    "picture",
    "screen",
    "screenshot",
    "selected",
    "selection",
    "that",
    "these",
    "this",
    "those",
    "visible",
    "window",
}
STANDALONE_TASK_PATTERN = re.compile(
    r"\b(can you|could you|please|write|create|build|make|implement|generate|draft|summarize|explain|fix|update|open|find|search|read|analyze|help|tell me)\b"
)
STANDALONE_QUESTION_PATTERN = re.compile(
    r"^(what is|what are|who is|where is|when is|why is|why are|how do|how can|how to)\b"
)
WAKE_ONLY_SPOKEN_INPUTS = {
    "hay bee",
    "hay bees",
    "hey b",
    "hey be",
    "hey bee",
    "hey bees",
    "hey beez",
    "hey peace",
    "hey piece",
}
INCOMPLETE_SPOKEN_INPUTS = {
    "can",
    "can you",
    "could",
    "could you",
    "please",
    "write",
    "create",
    "build",
    "make",
    "implement",
    "generate",
    "draft",
    "summarize",
    "explain",
    "fix",
    "update",
    "open",
    "find",
    "search",
    "read",
    "analyze",
    "help",
    "tell",
    "show",
    "do",
    "take",
    "use",
    "what",
    "why",
    "how",
    "who",
    "where",
    "when",
}


def spoken_input_needs_capture_context(spoken_input: str) -> bool:
    words = set(re.sub(r"[^a-z0-9 ]+", " ", spoken_input.lower()).split())
    return bool(words & CAPTURE_CONTEXT_WORDS)


def spoken_input_looks_incomplete(spoken_input: str) -> bool:
    normalized = re.sub(r"[^a-z0-9 ]+", " ", spoken_input.lower()).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    if not normalized:
        return True
    if normalized in INCOMPLETE_SPOKEN_INPUTS:
        return True

    words = normalized.split()
    if words[0] in {"can", "could"}:
        return len(words) < 4
    if words[0] == "please":
        return len(words) < 3
    if words[0] == "i" and len(words) >= 3 and words[1] in {"want", "need", "would", "can"}:
        return len(words) < 4
    return len(words) <= 1


def spoken_input_looks_standalone_task(spoken_input: str) -> bool:
    normalized = re.sub(r"[^a-z0-9 ]+", " ", spoken_input.lower()).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    if spoken_input_looks_incomplete(normalized):
        return False
    return bool(STANDALONE_TASK_PATTERN.search(normalized) or STANDALONE_QUESTION_PATTERN.search(normalized))


def should_emit_voice_transcript(spoken_input: str) -> bool:
    raw = str(spoken_input or "").strip()
    if not raw or raw == "[input pending]":
        return False
    normalized = re.sub(r"[^a-z0-9 ]+", " ", raw.lower()).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    return (
        bool(normalized)
        and normalized != "input pending"
        and normalized not in WAKE_ONLY_SPOKEN_INPUTS
        and not spoken_input_needs_capture_context(normalized)
        and spoken_input_looks_standalone_task(normalized)
    )


class QuietThreadingHTTPServer(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        exc_type, exc, _ = sys.exc_info()
        if isinstance(exc, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError)):
            return
        super().handle_error(request, client_address)


class ActivityDaemon:
    def __init__(self, config: ActivityConfig) -> None:
        self.config = config
        self.stop_event = threading.Event()
        self.state_lock = threading.Lock()
        self.capture_armed = False
        self.armed_until = 0.0
        self.last_spoken_input = ""
        self.last_arm_trigger = ""
        self.spoken_input_pending = False
        self.spoken_input_condition = threading.Condition(self.state_lock)
        self.last_disarm_reason: str | None = None
        self.last_selection_status: dict[str, Any] | None = None
        self.speech_suppression_leases: dict[str, dict[str, Any]] = {}
        self.arm_sequence = 0
        self.hover_capture_lock = threading.Lock()
        self.store = ActivityStore(config.database_path, config.retention_count)
        self.screen_capture = ScreenCapture(config.images_dir, config.cursor_crop_size)
        self.clipboard = ClipboardCollector()
        self.accessibility = AccessibilityCollector()
        self.input_events = InputEventCollector(
            on_selection=self.handle_selection,
            on_stop=self.stop,
            drag_threshold_pixels=config.drag_threshold_pixels,
            hover_capture_enabled=config.hover_capture_enabled,
            hover_delay_seconds=config.hover_delay_seconds,
            hover_cooldown_seconds=config.hover_cooldown_seconds,
            hover_min_move_pixels=config.hover_min_move_pixels,
        )
        self.speech = None
        self.sse_clients: list[queue.Queue[dict[str, Any]]] = []

    def start(self) -> None:
        self.config.root.mkdir(parents=True, exist_ok=True)
        self.config.images_dir.mkdir(parents=True, exist_ok=True)
        self.config.captures_dir.mkdir(parents=True, exist_ok=True)
        self.cleanup_captures()
        if self.config.collectors.clipboard:
            self.clipboard.start()
        if self.config.collectors.mouse:
            self.input_events.start()
        if self.config.collectors.speech:
            from .speech import SpeechArmController

            self.speech = SpeechArmController(
                self.config,
                arm_callback=self.arm_next_selection,
                spoken_input_callback=self.resolve_spoken_input,
                disarm_callback=self.disarm_selection,
                is_armed_callback=self.get_capture_armed,
                is_input_suppressed_callback=self.is_speech_input_suppressed,
                stop_event=self.stop_event,
            )
            if self.config.preload_asr_model:
                self.speech.preload_model()
            self.speech.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.input_events.stop()
        self.clipboard.stop()
        if self.speech:
            self.speech.stop()
        self.cleanup_captures()

    def cleanup_captures(self) -> None:
        captures_dir = self.config.captures_dir
        if not captures_dir.exists():
            return

        for entry in captures_dir.iterdir():
            try:
                if entry.is_symlink() or entry.is_file():
                    entry.unlink()
                elif entry.is_dir():
                    shutil.rmtree(entry)
            except Exception as error:
                print(f"[activity-daemon] failed to delete capture artifact {entry}: {error}", flush=True)

    def health(self) -> dict[str, Any]:
        with self.state_lock:
            self._prune_speech_suppression_leases_locked()
            armed_remaining_seconds = max(0.0, self.armed_until - time.monotonic()) if self.capture_armed else 0.0
            last_spoken_input = self.last_spoken_input
            last_disarm_reason = self.last_disarm_reason
            last_selection_status = self.last_selection_status
            speech_input_suppressed = bool(self.speech_suppression_leases)
        return {
            "status": "stopping" if self.stop_event.is_set() else "ok",
            "version": "0.1.0",
            "platform": self.platform_payload(),
            "armed": self.get_capture_armed(),
            "armed_remaining_seconds": round(armed_remaining_seconds, 2),
            "last_spoken_input": last_spoken_input,
            "last_disarm_reason": last_disarm_reason,
            "last_selection_status": last_selection_status,
            "speech_input_suppressed": speech_input_suppressed,
            "data_dir": str(self.config.root),
            "captures_dir": str(self.config.captures_dir),
            "collectors": {
                "screenshot": self._collector_status(self.config.collectors.screenshot, self.screen_capture.availability()),
                "mouse": self._collector_status(self.config.collectors.mouse, self.input_events.availability()),
                "speech": self._collector_status(self.config.collectors.speech, self.speech.availability() if self.speech else {"enabled": True, "available": False, "permission_required": True, "last_error": "Speech collector not started."}),
                "clipboard": self._collector_status(self.config.collectors.clipboard, self.clipboard.availability()),
                "active_window": self._collector_status(self.config.collectors.active_window, window_availability()),
                "accessibility": self._collector_status(self.config.collectors.accessibility, self.accessibility.availability()),
            },
        }

    def _prune_speech_suppression_leases_locked(self) -> None:
        now = time.monotonic()
        expired = [
            token
            for token, lease in self.speech_suppression_leases.items()
            if float(lease.get("until", 0.0)) <= now
        ]
        for token in expired:
            self.speech_suppression_leases.pop(token, None)

    def suppress_speech_input(self, reason: str = "external voice input", ttl_seconds: float = 180.0) -> dict[str, Any]:
        token = str(uuid.uuid4())
        ttl = max(1.0, min(float(ttl_seconds), 900.0))
        with self.state_lock:
            self._prune_speech_suppression_leases_locked()
            self.speech_suppression_leases[token] = {
                "reason": reason,
                "until": time.monotonic() + ttl,
            }
            lease_count = len(self.speech_suppression_leases)
        print(f"[activity-daemon] speech input suppressed: {reason}", flush=True)
        return {
            "token": token,
            "suppressed": True,
            "lease_count": lease_count,
            "ttl_seconds": ttl,
        }

    def release_speech_input(self, token: str | None = None) -> dict[str, Any]:
        with self.state_lock:
            self._prune_speech_suppression_leases_locked()
            if token:
                self.speech_suppression_leases.pop(token, None)
            else:
                self.speech_suppression_leases.clear()
            suppressed = bool(self.speech_suppression_leases)
            lease_count = len(self.speech_suppression_leases)
        print("[activity-daemon] speech input suppression released", flush=True)
        return {
            "suppressed": suppressed,
            "lease_count": lease_count,
        }

    def transcribe_speech_file(self, audio_path: str, language: str | None = None) -> dict[str, Any]:
        if not self.speech:
            raise RuntimeError("Speech collector is not running.")
        resolved = Path(audio_path).expanduser().resolve()
        if not resolved.exists() or not resolved.is_file():
            raise FileNotFoundError(f"Audio file does not exist: {resolved}")
        return self.speech.transcribe_file(str(resolved), language)

    def is_speech_input_suppressed(self) -> bool:
        with self.state_lock:
            self._prune_speech_suppression_leases_locked()
            return bool(self.speech_suppression_leases)

    def _collector_status(self, enabled: bool, status: dict[str, Any]) -> dict[str, Any]:
        return {
            **status,
            "enabled": bool(enabled),
            "available": bool(enabled) and bool(status.get("available")),
        }

    def platform_payload(self) -> dict[str, str]:
        return {
            "system": platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "machine": platform.machine(),
        }

    def update_config(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self.state_lock:
            self.config.update(patch)
            self.screen_capture.cursor_crop_size = self.config.cursor_crop_size
            self.input_events.drag_threshold_pixels = self.config.drag_threshold_pixels
            self.input_events.hover_capture_enabled = self.config.hover_capture_enabled
            self.input_events.hover_delay_seconds = self.config.hover_delay_seconds
            self.input_events.hover_cooldown_seconds = self.config.hover_cooldown_seconds
            self.input_events.hover_min_move_pixels = self.config.hover_min_move_pixels
            self.store.set_retention_count(self.config.retention_count)
            save_config(self.config)
        return self.config.to_dict()

    def arm_next_selection(
        self,
        spoken_input: str = "[input pending]",
        trigger: str = "voice_wake",
        input_pending: bool | None = None,
    ) -> dict[str, Any]:
        with self.state_lock:
            self._prune_speech_suppression_leases_locked()
            if trigger == "voice_wake" and self.speech_suppression_leases:
                self.last_disarm_reason = "Speech input suppressed by browser voice recorder."
                return {
                    "armed": False,
                    "suppressed": True,
                    "spoken_input": spoken_input,
                }
            self.arm_sequence += 1
            arm_sequence = self.arm_sequence
            self.capture_armed = True
            self.armed_until = time.monotonic() + self.config.armed_timeout_seconds
            self.last_spoken_input = spoken_input
            self.last_arm_trigger = trigger
            self.spoken_input_pending = bool(input_pending)
            self.last_disarm_reason = None
            armed_until = self.armed_until
            timeout_seconds = self.config.armed_timeout_seconds
            threading.Thread(target=self.capture_screenshot_when_arm_expires, args=(arm_sequence,), daemon=True).start()
            result = {
                "armed": True,
                "armed_until_monotonic": armed_until,
                "timeout_seconds": timeout_seconds,
                "spoken_input": self.last_spoken_input,
            }
        self._broadcast(
            {
                "id": str(uuid.uuid4()),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "trigger": trigger,
                "spoken_input": spoken_input,
            }
        )
        return result

    def resolve_spoken_input(self, spoken_input: str = "[input pending]") -> None:
        normalized_spoken_input = str(spoken_input or "").strip()
        with self.spoken_input_condition:
            self.last_spoken_input = normalized_spoken_input or "[input pending]"
            self.spoken_input_pending = False
            self.spoken_input_condition.notify_all()

    def wait_for_spoken_input(self, timeout_seconds: float = 10.0) -> None:
        deadline = time.monotonic() + timeout_seconds
        with self.spoken_input_condition:
            while self.spoken_input_pending:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.spoken_input_pending = False
                    break
                self.spoken_input_condition.wait(remaining)

    def spoken_input_wait_timeout_seconds(self) -> float:
        if not self.spoken_input_pending:
            return 0.0
        return max(
            10.0,
            float(self.config.command_listen_timeout_seconds)
            + float(self.config.command_phrase_time_limit_seconds)
            + 15.0,
        )

    def disarm_selection(self, reason: str | None = None) -> None:
        with self.state_lock:
            self.capture_armed = False
            self.armed_until = 0.0
            self.arm_sequence += 1
            self.last_disarm_reason = reason

    def get_capture_armed(self) -> bool:
        with self.state_lock:
            return self.capture_armed and time.monotonic() <= self.armed_until

    def capture_screenshot_when_arm_expires(self, arm_sequence: int) -> None:
        while not self.stop_event.is_set():
            with self.state_lock:
                if not self.capture_armed or self.arm_sequence != arm_sequence:
                    return
                remaining = self.armed_until - time.monotonic()
                if remaining <= 0:
                    spoken_input = str(self.last_spoken_input or "").strip()
                    spoken_pending = self.last_arm_trigger == "voice_wake" and self.spoken_input_pending
                    self.capture_armed = False
                    self.armed_until = 0.0
                    fallback_trigger = "manual_screenshot" if self.last_arm_trigger == "manual_arm" else "voice_screenshot"
                    publish_wait_seconds = self.spoken_input_wait_timeout_seconds() if spoken_pending else 0.0
                    if self.last_arm_trigger == "voice_wake" and spoken_input in {"", "[input pending]"} and not spoken_pending:
                        self.last_disarm_reason = "No drag selection or spoken input detected after wake."
                        return
                    self.last_disarm_reason = "No drag selection detected; captured screenshot."
                    break
            if self.stop_event.wait(min(remaining, 0.25)):
                return

        if self.stop_event.is_set():
            return
        print(
            "[activity-daemon] no drag selection detected; capturing screenshot "
            f"after {self.config.armed_timeout_seconds:.1f}s arm timeout "
            f"(trigger={fallback_trigger}, spoken_input_pending={publish_wait_seconds > 0})",
            flush=True,
        )
        self.capture_snapshot(
            trigger=fallback_trigger,
            include_base64=False,
            include_full_screen=True,
            include_cursor_crop=False,
            include_selection_crop=False,
            wait_for_spoken_input_before_publish_seconds=publish_wait_seconds,
        )

    def handle_selection(self, start_pos: tuple[int, int], end_pos: tuple[int, int]) -> None:
        with self.state_lock:
            is_armed = self.capture_armed and time.monotonic() <= self.armed_until
            self.capture_armed = False
            self.armed_until = 0.0
            self.last_selection_status = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "start": {"x": start_pos[0], "y": start_pos[1]},
                "end": {"x": end_pos[0], "y": end_pos[1]},
                "accepted": is_armed,
                "armed": is_armed,
                "reason": "accepted from wake-word arm" if is_armed else "ignored because capture was not armed or had timed out",
            }
        if not is_armed:
            print(f"[activity-daemon] ignored drag selection while not armed: {start_pos} -> {end_pos}", flush=True)
            return
        print(f"[activity-daemon] accepted voice_selection: {start_pos} -> {end_pos}", flush=True)
        self.wait_for_spoken_input(self.spoken_input_wait_timeout_seconds())
        time.sleep(0.35)
        with self.state_lock:
            trigger = "manual_selection" if self.last_arm_trigger == "manual_arm" else "voice_selection"
        event = self.capture_snapshot(
            trigger=trigger,
            drag_start=start_pos,
            drag_end=end_pos,
            include_cursor_crop=False,
            include_selection_crop=True,
        )
        with self.state_lock:
            if self.last_selection_status:
                self.last_selection_status["event_id"] = event["id"]
                self.last_selection_status["event_json"] = event.get("files", {}).get("event_json")
                self.last_selection_status["selection_text_length"] = len(event.get("text", {}).get("selection_text", ""))

    def handle_hover(self, position: tuple[int, int]) -> None:
        # A hover must not consume the voice capture arm. If no drag selection
        # arrives, capture_screenshot_when_arm_expires owns the screenshot fallback.
        return

    def capture_snapshot(
        self,
        trigger: str = "manual",
        drag_start: tuple[int, int] | None = None,
        drag_end: tuple[int, int] | None = None,
        include_base64: bool | None = None,
        include_full_screen: bool = False,
        include_cursor_crop: bool = True,
        include_selection_crop: bool = True,
        wait_for_spoken_input_before_publish_seconds: float = 0.0,
    ) -> dict[str, Any]:
        event_id = str(uuid.uuid4())
        event_time = datetime.now(timezone.utc)
        artifact_dir = self._artifact_dir(event_time, event_id)
        event_id = str(uuid.uuid4())
        event_time = datetime.now(timezone.utc)
        artifact_dir = self._artifact_dir(event_time, event_id)
        images_dir = artifact_dir / "images"
        event_json_path = artifact_dir / "event.json"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        images_dir.mkdir(parents=True, exist_ok=True)

        mouse_position = drag_end or self.input_events.current_position()
        recent_path = self.input_events.recent_path()
        include_base64 = self.config.include_base64_by_default if include_base64 is None else include_base64

        privacy: dict[str, Any] = {"local_only": True, "remote_send": False, "captured": {}, "unavailable": {}}
        images: dict[str, Any] = {"cursor_crop": None, "selection_crop": None, "screenshot": None}
        if self.config.collectors.screenshot:
            try:
                if include_full_screen:
                    print(f"[activity-daemon] capturing full-screen screenshot for {trigger}", flush=True)
                images = self.screen_capture.capture_context_images(
                    mouse_position,
                    drag_start,
                    drag_end,
                    include_base64,
                    include_full_screen,
                    include_cursor_crop,
                    include_selection_crop,
                    images_dir,
                    recent_path=recent_path,
                )
                privacy["captured"]["images"] = True
            except Exception as error:
                privacy["captured"]["images"] = False
                privacy["unavailable"]["images"] = str(error)

        clipboard_snapshot = {"clipboard_text": "", "primary_selection_text": ""}
        selected_text_snapshot = {"selection_text": "", "method": None, "clipboard_restored": False, "last_error": None}
        if self.config.collectors.clipboard:
            if drag_start and drag_end and self.config.copy_selection_to_extract_text:
                selected_text_snapshot = self.clipboard.capture_selected_text_via_copy(
                    timeout_seconds=self.config.selection_copy_timeout_seconds,
                    preserve_clipboard=self.config.preserve_clipboard_after_selection_copy,
                )
                privacy["captured"]["selection_text"] = bool(selected_text_snapshot.get("selection_text"))
                if selected_text_snapshot.get("last_error"):
                    privacy["unavailable"]["selection_text"] = selected_text_snapshot.get("last_error")
            self.clipboard.refresh()
            clipboard_snapshot = self.clipboard.snapshot()
            privacy["captured"]["clipboard"] = True

        accessibility_snapshot = {"hover_text": "", "focused_text": "", "last_error": None}
        if self.config.collectors.accessibility:
            accessibility_snapshot = self.accessibility.snapshot()
            privacy["captured"]["accessibility"] = not bool(accessibility_snapshot.get("last_error"))
            if accessibility_snapshot.get("last_error"):
                privacy["unavailable"]["accessibility"] = accessibility_snapshot.get("last_error")

        active_window = {"title": None, "app_name": None, "process_name": None, "pid": None, "bounds": None}
        if self.config.collectors.active_window:
            active_window = get_active_window_context()
            privacy["captured"]["active_window"] = not bool(active_window.get("last_error"))
            if active_window.get("last_error"):
                privacy["unavailable"]["active_window"] = active_window.get("last_error")

        if wait_for_spoken_input_before_publish_seconds > 0:
            print(
                "[activity-daemon] screenshot captured; waiting for spoken input before publishing "
                f"(timeout={wait_for_spoken_input_before_publish_seconds:.1f}s)",
                flush=True,
            )
            self.wait_for_spoken_input(wait_for_spoken_input_before_publish_seconds)

        with self.state_lock:
            spoken_input = self.last_spoken_input

        selection_text = selected_text_snapshot.get("selection_text", "")
        selection_text_source = selected_text_snapshot.get("method")

        event = {
            "id": event_id,
            "timestamp": event_time.isoformat(),
            "trigger": trigger,
            "platform": self.platform_payload(),
            "spoken_input": spoken_input,
            "active_window": active_window,
            "mouse": {
                "current_position": {"x": mouse_position[0], "y": mouse_position[1]} if mouse_position else None,
                "drag_start": {"x": drag_start[0], "y": drag_start[1]} if drag_start else None,
                "drag_end": {"x": drag_end[0], "y": drag_end[1]} if drag_end else None,
                "recent_path": recent_path,
            },
            "text": {
                "clipboard_text": clipboard_snapshot.get("clipboard_text", ""),
                "selection_text": selection_text,
                "selection_text_source": selection_text_source,
                "selection_clipboard_restored": selected_text_snapshot.get("clipboard_restored", False),
                "selection_copy_error": selected_text_snapshot.get("last_error"),
                "primary_selection_text": clipboard_snapshot.get("primary_selection_text", ""),
                "hover_text": accessibility_snapshot.get("hover_text", ""),
                "focused_text": accessibility_snapshot.get("focused_text", ""),
            },
            "images": images,
            "files": {
                "artifact_dir": str(artifact_dir),
                "event_json": str(event_json_path),
                "images_dir": str(images_dir),
            },
            "privacy": privacy,
        }
        self._write_event_json(event, event_json_path)
        self.store.add_event(event)
        self._broadcast(event)
        if images.get("screenshot"):
            print(
                "[activity-daemon] published screenshot capture event: "
                f"id={event_id}, trigger={trigger}, spoken_input={spoken_input!r}, "
                f"path={images['screenshot'].get('path')}",
                flush=True,
            )
        return event

    def _artifact_dir(self, event_time: datetime, event_id: str):
        folder_name = f"{event_time.strftime('%Y%m%dT%H%M%S%fZ')}_{event_id[:8]}"
        return self.config.captures_dir / folder_name

    def _write_event_json(self, event: dict[str, Any], path) -> None:
        try:
            with path.open("w", encoding="utf-8") as f:
                json.dump(event, f, ensure_ascii=False, indent=2)
        except Exception as error:
            event["privacy"]["unavailable"]["event_json"] = str(error)

    def context_payload(self, event: dict[str, Any]) -> dict[str, Any]:
        return build_context_payload(event)

    def add_sse_client(self) -> queue.Queue[dict[str, Any]]:
        client_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=20)
        self.sse_clients.append(client_queue)
        return client_queue

    def remove_sse_client(self, client_queue: queue.Queue[dict[str, Any]]) -> None:
        try:
            self.sse_clients.remove(client_queue)
        except ValueError:
            pass

    def _broadcast(self, event: dict[str, Any]) -> None:
        for client_queue in list(self.sse_clients):
            try:
                client_queue.put_nowait(event)
            except queue.Full:
                self.remove_sse_client(client_queue)


class ActivityRequestHandler(BaseHTTPRequestHandler):
    daemon_ref: ActivityDaemon

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_json(self.daemon_ref.health())
            return
        if parsed.path == "/config":
            self._send_json(self.daemon_ref.config.to_dict())
            return
        if parsed.path == "/events/latest":
            latest = self.daemon_ref.store.latest()
            self._send_json(latest if latest else {}, status=HTTPStatus.OK if latest else HTTPStatus.NOT_FOUND)
            return
        if parsed.path == "/events":
            query = parse_qs(parsed.query)
            limit = int(query.get("limit", ["50"])[0])
            self._send_json({"events": self.daemon_ref.store.list_events(limit=limit)})
            return
        if parsed.path == "/events/stream":
            self._send_stream()
            return
        self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/config":
            payload = self._read_json()
            self._send_json(self.daemon_ref.update_config(payload))
            return
        self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/arm":
            payload = self._read_json(default={})
            spoken_input = str(payload.get("spoken_input") or "[input pending]")
            self._send_json(self.daemon_ref.arm_next_selection(spoken_input, trigger="manual_arm"))
            return
        if parsed.path == "/speech/suppress":
            payload = self._read_json(default={})
            reason = str(payload.get("reason") or "external voice input")
            ttl_seconds = float(payload.get("ttl_seconds") or 180.0)
            self._send_json(self.daemon_ref.suppress_speech_input(reason=reason, ttl_seconds=ttl_seconds))
            return
        if parsed.path == "/speech/release":
            payload = self._read_json(default={})
            token = payload.get("token")
            self._send_json(self.daemon_ref.release_speech_input(token if isinstance(token, str) else None))
            return
        if parsed.path == "/speech/transcribe-file":
            payload = self._read_json(default={})
            audio_path = str(payload.get("audio_path") or payload.get("audioPath") or "").strip()
            language = payload.get("language")
            if not audio_path:
                self._send_json({"error": "audio_path is required"}, status=HTTPStatus.BAD_REQUEST)
                return
            try:
                self._send_json(self.daemon_ref.transcribe_speech_file(
                    audio_path,
                    language if isinstance(language, str) and language.strip() else None,
                ))
            except FileNotFoundError as error:
                self._send_json({"error": str(error)}, status=HTTPStatus.NOT_FOUND)
            except Exception as error:
                self._send_json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if parsed.path == "/capture":
            payload = self._read_json(default={})
            if "spoken_input" in payload:
                with self.daemon_ref.state_lock:
                    self.daemon_ref.last_spoken_input = str(payload.get("spoken_input") or "[input pending]")
            drag_start = _point_tuple(payload.get("drag_start"))
            drag_end = _point_tuple(payload.get("drag_end"))
            include_base64 = bool(payload.get("include_base64", False))
            include_full_screen = bool(payload.get("include_full_screen", False))
            include_cursor_crop = payload.get("include_cursor_crop", True) is not False
            include_selection_crop = payload.get("include_selection_crop", True) is not False
            event = self.daemon_ref.capture_snapshot(
                trigger=str(payload.get("trigger") or "manual"),
                drag_start=drag_start,
                drag_end=drag_end,
                include_base64=include_base64,
                include_full_screen=include_full_screen,
                include_cursor_crop=include_cursor_crop,
                include_selection_crop=include_selection_crop,
            )
            self._send_json(event)
            return
        self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, fmt: str, *args: Any) -> None:
        if self.path.startswith("/health") or self.path.startswith("/events/stream"):
            return
        print(f"[activity-daemon] {self.address_string()} - {fmt % args}")

    def _read_json(self, default: dict[str, Any] | None = None) -> dict[str, Any]:
        default = {} if default is None else default
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return default
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw or "{}")

    def _send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_stream(self) -> None:
        client_queue = self.daemon_ref.add_sse_client()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            # Flush headers immediately — wfile is buffered, so without this the client
            # receives no data until the first keep-alive fires 15 s later, which causes
            # undici to destroy the socket and report UND_ERR_SOCKET ("terminated").
            try:
                self.wfile.flush()
            except OSError:
                return
            latest = self.daemon_ref.store.latest()
            if latest:
                try:
                    self.wfile.write(f"event: snapshot\ndata: {json.dumps(latest, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except OSError:
                    return
                except Exception:
                    pass  # skip if the stored event can't be serialised
            while not self.daemon_ref.stop_event.is_set():
                try:
                    event = client_queue.get(timeout=15)
                    self.wfile.write(f"event: snapshot\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                except OSError:
                    return
                except Exception:
                    continue  # skip malformed events, don't flush
                try:
                    self.wfile.flush()
                except OSError:
                    return
        except OSError:
            return
        finally:
            self.daemon_ref.remove_sse_client(client_queue)


def _point_tuple(value: Any) -> tuple[int, int] | None:
    if isinstance(value, dict) and "x" in value and "y" in value:
        return int(value["x"]), int(value["y"])
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return int(value[0]), int(value[1])
    return None


def run_server(host: str, port: int, config: ActivityConfig) -> None:
    daemon = ActivityDaemon(config)
    ActivityRequestHandler.daemon_ref = daemon
    server = QuietThreadingHTTPServer((host, port), ActivityRequestHandler)

    def stop_server(*_: Any) -> None:
        daemon.stop()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop_server)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop_server)

    daemon.start()
    print(f"[activity-daemon] listening on http://{host}:{port}")
    print(f"[activity-daemon] data dir: {config.root}")
    try:
        server.serve_forever()
    finally:
        daemon.stop()
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="OneInfer local activity collector daemon")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4768)
    parser.add_argument("--config", default=None)
    args = parser.parse_args()

    config = load_config(args.config)
    run_server(args.host, args.port, config)


if __name__ == "__main__":
    main()
