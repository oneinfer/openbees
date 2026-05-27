from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import platform
import queue
import signal
import threading
import time
import uuid
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


class ActivityDaemon:
    def __init__(self, config: ActivityConfig) -> None:
        self.config = config
        self.stop_event = threading.Event()
        self.state_lock = threading.Lock()
        self.capture_armed = False
        self.armed_until = 0.0
        self.last_spoken_input = ""
        self.last_disarm_reason: str | None = None
        self.last_selection_status: dict[str, Any] | None = None
        self.store = ActivityStore(config.database_path, config.retention_count)
        self.screen_capture = ScreenCapture(config.images_dir, config.cursor_crop_size)
        self.clipboard = ClipboardCollector()
        self.accessibility = AccessibilityCollector()
        self.input_events = InputEventCollector(
            on_selection=self.handle_selection,
            on_stop=self.stop,
            drag_threshold_pixels=config.drag_threshold_pixels,
        )
        self.speech = None
        self.sse_clients: list[queue.Queue[dict[str, Any]]] = []

    def start(self) -> None:
        self.config.root.mkdir(parents=True, exist_ok=True)
        self.config.images_dir.mkdir(parents=True, exist_ok=True)
        self.config.captures_dir.mkdir(parents=True, exist_ok=True)
        if self.config.collectors.clipboard:
            self.clipboard.start()
        if self.config.collectors.mouse:
            self.input_events.start()
        if self.config.collectors.speech:
            from .speech import SpeechArmController

            self.speech = SpeechArmController(
                self.config,
                arm_callback=self.arm_next_selection,
                disarm_callback=self.disarm_selection,
                is_armed_callback=self.get_capture_armed,
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

    def health(self) -> dict[str, Any]:
        with self.state_lock:
            armed_remaining_seconds = max(0.0, self.armed_until - time.monotonic()) if self.capture_armed else 0.0
            last_spoken_input = self.last_spoken_input
            last_disarm_reason = self.last_disarm_reason
            last_selection_status = self.last_selection_status
        return {
            "status": "stopping" if self.stop_event.is_set() else "ok",
            "version": "0.1.0",
            "platform": self.platform_payload(),
            "armed": self.get_capture_armed(),
            "armed_remaining_seconds": round(armed_remaining_seconds, 2),
            "last_spoken_input": last_spoken_input,
            "last_disarm_reason": last_disarm_reason,
            "last_selection_status": last_selection_status,
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
            self.store.set_retention_count(self.config.retention_count)
            save_config(self.config)
        return self.config.to_dict()

    def arm_next_selection(self, spoken_input: str = "[input pending]") -> dict[str, Any]:
        with self.state_lock:
            self.capture_armed = True
            self.armed_until = time.monotonic() + self.config.armed_timeout_seconds
            self.last_spoken_input = spoken_input
            self.last_disarm_reason = None
            return {
                "armed": True,
                "armed_until_monotonic": self.armed_until,
                "timeout_seconds": self.config.armed_timeout_seconds,
                "spoken_input": self.last_spoken_input,
            }

    def disarm_selection(self, reason: str | None = None) -> None:
        with self.state_lock:
            self.capture_armed = False
            self.armed_until = 0.0
            self.last_disarm_reason = reason

    def get_capture_armed(self) -> bool:
        with self.state_lock:
            if not self.capture_armed:
                return False
            if time.monotonic() <= self.armed_until:
                return True
            self.capture_armed = False
            self.armed_until = 0.0
            self.last_disarm_reason = "Capture timed out."
            return False

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
                "reason": "accepted" if is_armed else "ignored because capture was not armed or had timed out",
            }
        if not is_armed:
            print(f"[activity-daemon] ignored drag selection while not armed: {start_pos} -> {end_pos}", flush=True)
            return
        print(f"[activity-daemon] accepted drag selection: {start_pos} -> {end_pos}", flush=True)
        time.sleep(0.35)
        event = self.capture_snapshot(trigger="voice_selection", drag_start=start_pos, drag_end=end_pos)
        with self.state_lock:
            if self.last_selection_status:
                self.last_selection_status["event_id"] = event["id"]
                self.last_selection_status["event_json"] = event.get("files", {}).get("event_json")
                self.last_selection_status["selection_text_length"] = len(event.get("text", {}).get("selection_text", ""))

    def capture_snapshot(
        self,
        trigger: str = "manual",
        drag_start: tuple[int, int] | None = None,
        drag_end: tuple[int, int] | None = None,
        include_base64: bool | None = None,
    ) -> dict[str, Any]:
        event_id = str(uuid.uuid4())
        event_time = datetime.now(timezone.utc)
        artifact_dir = self._artifact_dir(event_time, event_id)
        images_dir = artifact_dir / "images"
        event_json_path = artifact_dir / "event.json"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        images_dir.mkdir(parents=True, exist_ok=True)

        mouse_position = drag_end or self.input_events.current_position()
        include_base64 = self.config.include_base64_by_default if include_base64 is None else include_base64

        privacy: dict[str, Any] = {"local_only": True, "remote_send": False, "captured": {}, "unavailable": {}}
        images: dict[str, Any] = {"cursor_crop": None, "selection_crop": None}
        if self.config.collectors.screenshot:
            try:
                images = self.screen_capture.capture_context_images(mouse_position, drag_start, drag_end, include_base64, images_dir)
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

        with self.state_lock:
            spoken_input = self.last_spoken_input

        selection_text = selected_text_snapshot.get("selection_text", "")
        selection_text_source = selected_text_snapshot.get("method")
        if not selection_text and not (drag_start and drag_end):
            selection_text = clipboard_snapshot.get("primary_selection_text") or clipboard_snapshot.get("clipboard_text", "")
            selection_text_source = "primary_selection" if clipboard_snapshot.get("primary_selection_text") else "clipboard"

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
                "recent_path": self.input_events.recent_path(),
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
            self._send_json(self.daemon_ref.arm_next_selection(spoken_input))
            return
        if parsed.path == "/capture":
            payload = self._read_json(default={})
            drag_start = _point_tuple(payload.get("drag_start"))
            drag_end = _point_tuple(payload.get("drag_end"))
            include_base64 = bool(payload.get("include_base64", False))
            event = self.daemon_ref.capture_snapshot(
                trigger=str(payload.get("trigger") or "manual"),
                drag_start=drag_start,
                drag_end=drag_end,
                include_base64=include_base64,
            )
            self._send_json(event)
            return
        self._send_json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, fmt: str, *args: Any) -> None:
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
            latest = self.daemon_ref.store.latest()
            if latest:
                try:
                    self.wfile.write(f"event: snapshot\ndata: {json.dumps(latest, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return
            while not self.daemon_ref.stop_event.is_set():
                try:
                    event = client_queue.get(timeout=15)
                    self.wfile.write(f"event: snapshot\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                try:
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    return
                except OSError:
                    return
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
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
    server = ThreadingHTTPServer((host, port), ActivityRequestHandler)

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
