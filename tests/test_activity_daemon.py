from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from activity_daemon.capture import clamp_region_to_screen, find_highlight_bounds
from activity_daemon.clipboard import ClipboardCollector
from activity_daemon.config import ActivityConfig
from activity_daemon.daemon import ActivityDaemon
from activity_daemon.speech import contains_wake_word, normalize_spoken_text
from activity_daemon.store import ActivityStore


class FakeScreenshot:
    def __init__(self, width: int, height: int, blue_points: set[tuple[int, int]]) -> None:
        self.size = (width, height)
        data = bytearray([255, 255, 255] * width * height)
        for x, y in blue_points:
            offset = (y * width + x) * 3
            data[offset] = 40
            data[offset + 1] = 110
            data[offset + 2] = 220
        self.rgb = bytes(data)


class ActivityDaemonTests(unittest.TestCase):
    def test_wake_word_normalization_and_matching(self) -> None:
        self.assertEqual(normalize_spoken_text(" Hey,   Bees! "), "hey bees")
        self.assertTrue(contains_wake_word("hey peace can you help"))
        self.assertTrue(contains_wake_word("hay bee"))
        self.assertFalse(contains_wake_word("abc"))

    def test_region_clamps_to_screen(self) -> None:
        screen = {"left": 0, "top": 0, "width": 100, "height": 80}
        region = clamp_region_to_screen(-20, -10, 160, 140, screen)
        self.assertEqual(region, {"left": 0, "top": 0, "width": 100, "height": 80})

    def test_highlight_detection_returns_bounds(self) -> None:
        points = {(x, y) for x in range(5, 15) for y in range(4, 8)}
        bounds = find_highlight_bounds(FakeScreenshot(30, 20, points))
        self.assertEqual(bounds, (5, 4, 15, 8))

    def test_store_retention_keeps_latest_events(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = ActivityStore(Path(temp_dir) / "events.sqlite3", retention_count=2)
            for index in range(3):
                store.add_event(
                    {
                        "id": str(index),
                        "timestamp": f"2026-01-01T00:00:0{index}+00:00",
                        "trigger": "test",
                    }
                )
            events = store.list_events(limit=10)
            self.assertEqual([event["id"] for event in events], ["2", "1"])

    def test_snapshot_schema_survives_disabled_collectors(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.screenshot = False
            config.collectors.clipboard = False
            config.collectors.active_window = False
            config.collectors.accessibility = False
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            daemon.input_events.record_position(10, 20)
            event = daemon.capture_snapshot(trigger="test")

            self.assertEqual(event["trigger"], "test")
            self.assertEqual(event["mouse"]["current_position"], {"x": 10, "y": 20})
            self.assertIn("active_window", event)
            self.assertIn("text", event)
            self.assertTrue(event["privacy"]["local_only"])

    def test_drag_snapshot_uses_copied_selection_text(self) -> None:
        class FakeClipboard:
            def capture_selected_text_via_copy(self, timeout_seconds: float, preserve_clipboard: bool):
                return {
                    "selection_text": "highlighted text",
                    "method": "keyboard_copy",
                    "clipboard_restored": preserve_clipboard,
                    "last_error": None,
                }

            def refresh(self) -> None:
                return None

            def snapshot(self):
                return {"clipboard_text": "old clipboard", "primary_selection_text": ""}

        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.screenshot = False
            config.collectors.active_window = False
            config.collectors.accessibility = False
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            daemon.clipboard = FakeClipboard()

            event = daemon.capture_snapshot(trigger="voice_selection", drag_start=(10, 10), drag_end=(100, 20))

            self.assertEqual(event["text"]["selection_text"], "highlighted text")
            self.assertEqual(event["text"]["selection_text_source"], "keyboard_copy")
            self.assertTrue(event["text"]["selection_clipboard_restored"])
            self.assertTrue(event["privacy"]["captured"]["selection_text"])

    def test_selection_copy_does_not_return_old_clipboard_when_copy_fails(self) -> None:
        collector = ClipboardCollector()
        clipboard_values: list[str] = ["old clipboard"]

        def read_clipboard() -> str:
            return clipboard_values[-1]

        def write_clipboard(value: str) -> None:
            clipboard_values.append(value)

        collector._read_clipboard = read_clipboard  # type: ignore[method-assign]
        collector._write_clipboard = write_clipboard  # type: ignore[method-assign]
        collector._send_copy_shortcut = lambda: None  # type: ignore[method-assign]

        result = collector.capture_selected_text_via_copy(timeout_seconds=0.1, preserve_clipboard=True)

        self.assertEqual(result["selection_text"], "")
        self.assertTrue(result["clipboard_restored"])
        self.assertEqual(clipboard_values[-1], "old clipboard")


if __name__ == "__main__":
    unittest.main()
