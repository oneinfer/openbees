from __future__ import annotations

import tempfile
import threading
import time
import unittest
import json
import os
from pathlib import Path
from unittest.mock import patch

from activity_daemon.capture import clamp_region_to_screen, find_highlight_bounds
from activity_daemon.clipboard import ClipboardCollector
from activity_daemon.config import ActivityConfig, load_config
from activity_daemon.daemon import ActivityDaemon, should_emit_voice_transcript
from activity_daemon.input_events import InputEventCollector
from activity_daemon.speech import OpenWakeWordDetector, SpeechArmController, command_after_wake_phrase, command_like_spoken_input, confirmed_wake_spoken_input, contains_wake_word, meaningful_spoken_input, merge_spoken_input_prefix, normalize_spoken_text
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
    def make_speech_controller(self, config: ActivityConfig) -> SpeechArmController:
        return SpeechArmController(
            config,
            arm_callback=lambda *args, **kwargs: None,
            spoken_input_callback=lambda _text: None,
            disarm_callback=lambda _reason: None,
            is_armed_callback=lambda: False,
            is_input_suppressed_callback=lambda: False,
            stop_event=threading.Event(),
        )

    def test_wake_word_normalization_and_matching(self) -> None:
        self.assertEqual(normalize_spoken_text(" Hey,   Bees! "), "hey bees")
        self.assertTrue(contains_wake_word("hey peace can you help"))
        self.assertTrue(contains_wake_word("hay bee"))
        self.assertTrue(contains_wake_word("a b"))
        self.assertTrue(contains_wake_word("have we can create a website like this"))
        self.assertTrue(contains_wake_word("heavy kind of creative website like this"))
        self.assertTrue(contains_wake_word("happy can a creative website"))
        self.assertTrue(contains_wake_word("so we can create a website like this"))
        self.assertTrue(contains_wake_word("rip"))
        self.assertTrue(contains_wake_word("piece"))
        self.assertFalse(contains_wake_word("a b", match_mode="strict"))
        self.assertFalse(contains_wake_word("rip", match_mode="strict"))
        self.assertFalse(contains_wake_word("abc"))
        self.assertEqual(command_after_wake_phrase("have we can create a website like this"), "can create a website like this")
        self.assertEqual(command_after_wake_phrase("happy can a creative website"), "can a creative website")
        self.assertEqual(command_after_wake_phrase("so we can create a website like this"), "can create a website like this")

    def test_input_pending_never_emits_voice_transcript(self) -> None:
        self.assertFalse(should_emit_voice_transcript("[input pending]"))
        self.assertFalse(should_emit_voice_transcript("input pending"))
        self.assertFalse(should_emit_voice_transcript(""))
        self.assertFalse(should_emit_voice_transcript("how about you"))
        self.assertFalse(should_emit_voice_transcript("random words"))
        self.assertTrue(should_emit_voice_transcript("write a linear search algorithm"))
        self.assertTrue(should_emit_voice_transcript("what is binary search"))

    def test_legacy_wakeword_post_capture_default_is_shortened(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            config_path.write_text(json.dumps({"data_dir": temp_dir, "wakeword_post_capture_seconds": 2.0}), encoding="utf-8")

            config = load_config(str(config_path))

            self.assertEqual(config.wakeword_post_capture_seconds, 0.35)

    def test_command_audio_timeouts_can_be_loaded_from_env(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.json"
            with patch.dict(
                os.environ,
                {
                    "COMMAND_LISTEN_TIMEOUT_SECONDS": "8",
                    "COMMAND_PHRASE_TIME_LIMIT_SECONDS": "45",
                },
            ):
                config = load_config(str(config_path))

            self.assertEqual(config.command_listen_timeout_seconds, 8)
            self.assertEqual(config.command_phrase_time_limit_seconds, 45)

    def test_noise_transcripts_do_not_become_commands(self) -> None:
        self.assertEqual(meaningful_spoken_input("the."), "")
        self.assertEqual(meaningful_spoken_input("okay."), "")
        self.assertEqual(meaningful_spoken_input("oh."), "")
        self.assertEqual(meaningful_spoken_input("i m"), "")
        self.assertEqual(command_like_spoken_input("i m"), "")
        self.assertEqual(command_like_spoken_input("random words"), "")
        self.assertEqual(command_like_spoken_input("can you"), "")
        self.assertEqual(command_like_spoken_input("can you write"), "")
        self.assertEqual(command_like_spoken_input("write"), "")
        self.assertEqual(command_like_spoken_input("yes i know that you do but"), "")
        self.assertEqual(command_like_spoken_input("the binary search program"), "")
        self.assertEqual(command_like_spoken_input("okay let s get it"), "")
        self.assertEqual(command_like_spoken_input("create a task"), "create a task")
        self.assertEqual(command_like_spoken_input("write a binary search program"), "write a binary search program")
        self.assertEqual(command_like_spoken_input("open settings"), "open settings")
        self.assertEqual(command_like_spoken_input("can you explain this"), "can you explain this")
        self.assertEqual(command_after_wake_phrase("hey bee the."), "")
        self.assertEqual(command_after_wake_phrase("hey bee can you"), "")
        self.assertEqual(command_after_wake_phrase("hey bee i m"), "")
        self.assertEqual(command_after_wake_phrase("hey bee okay let s get it"), "")
        self.assertEqual(command_after_wake_phrase("hey bee create a task"), "create a task")
        self.assertEqual(command_after_wake_phrase("hey bee can you explain this"), "can you explain this")
        self.assertEqual(confirmed_wake_spoken_input("the binary search program"), "the binary search program")
        self.assertEqual(confirmed_wake_spoken_input("write a binary search program"), "write a binary search program")
        self.assertEqual(confirmed_wake_spoken_input("okay let s get it"), "")
        self.assertEqual(
            merge_spoken_input_prefix("can you write a", "the binary search program"),
            "can you write a binary search program",
        )
        self.assertEqual(
            merge_spoken_input_prefix("can you write a binary", "binary search program"),
            "can you write a binary search program",
        )

    def test_wake_audio_ignores_non_command_transcripts_without_wake_phrase(self) -> None:
        config = ActivityConfig()
        controller = self.make_speech_controller(config)
        controller._transcribe_audio = lambda _audio, *args, **kwargs: "the text is in english"  # type: ignore[method-assign]

        self.assertEqual(controller._command_from_wake_audio(object()), "")

    def test_wake_audio_accepts_command_starters_without_wake_phrase(self) -> None:
        config = ActivityConfig()
        controller = self.make_speech_controller(config)
        controller._transcribe_audio = lambda _audio, *args, **kwargs: "write a program for binary search"  # type: ignore[method-assign]

        self.assertEqual(controller._command_from_wake_audio(object()), "write a program for binary search")

    def test_wake_audio_accepts_meaningful_text_after_explicit_wake_phrase(self) -> None:
        config = ActivityConfig()
        controller = self.make_speech_controller(config)
        controller._transcribe_audio = lambda _audio, *args, **kwargs: "hey bee the binary search program"  # type: ignore[method-assign]

        self.assertEqual(controller._command_from_wake_audio(object()), "the binary search program")

    def test_wake_audio_command_check_does_not_save_debug_asr_input(self) -> None:
        config = ActivityConfig()
        controller = self.make_speech_controller(config)
        calls: list[dict[str, object]] = []

        def fake_transcribe(_audio, label="audio", *, save_debug=True):
            calls.append({"label": label, "save_debug": save_debug})
            return "write a program for binary search"

        controller._transcribe_audio = fake_transcribe  # type: ignore[method-assign]

        self.assertEqual(controller._command_from_wake_audio(object()), "write a program for binary search")
        self.assertEqual(calls, [{"label": "wake_audio_command_check", "save_debug": False}])

    def test_openwakeword_detector_scores_padded_audio_chunks(self) -> None:
        class FakeModel:
            def __init__(self) -> None:
                self.models = {"hey_bee": object()}
                self.calls = 0
                self.reset_called = False

            def reset(self) -> None:
                self.reset_called = True

            def predict(self, chunk):
                self.calls += 1
                self.last_chunk_size = len(chunk)
                return {"hey_bee": 0.7 if self.calls == 2 else 0.1}

        class FakeAudio:
            def get_raw_data(self, *args, **kwargs):
                return (b"\x01\x00" * 12)

        with tempfile.TemporaryDirectory() as temp_dir:
            model_path = Path(temp_dir) / "hey_bee.onnx"
            model_path.write_bytes(b"model")
            config = ActivityConfig()
            config.wakeword_model_path = str(model_path)
            config.wakeword_chunk_size = 8
            config.wakeword_threshold = 0.5
            fake_model = FakeModel()
            detector = OpenWakeWordDetector(config, model_factory=lambda _path: fake_model)

            detected, score = detector.detect(FakeAudio())

            self.assertTrue(detected)
            self.assertEqual(score, 0.7)
            self.assertTrue(fake_model.reset_called)
            self.assertEqual(fake_model.calls, 2)
            self.assertEqual(fake_model.last_chunk_size, 8)

    def test_openwakeword_detector_streaming_chunks_keep_model_context(self) -> None:
        class FakeModel:
            def __init__(self) -> None:
                self.models = {"hey_bee": object()}
                self.calls = 0
                self.resets = 0

            def reset(self) -> None:
                self.resets += 1

            def predict(self, chunk):
                self.calls += 1
                self.last_chunk_size = len(chunk)
                return {"hey_bee": 0.7 if self.calls == 2 else 0.1}

        with tempfile.TemporaryDirectory() as temp_dir:
            model_path = Path(temp_dir) / "hey_bee.onnx"
            model_path.write_bytes(b"model")
            config = ActivityConfig()
            config.wakeword_model_path = str(model_path)
            config.wakeword_chunk_size = 8
            config.wakeword_threshold = 0.5
            fake_model = FakeModel()
            detector = OpenWakeWordDetector(config, model_factory=lambda _path: fake_model)

            first_detected, first_score = detector.predict_pcm16(b"\x01\x00" * 8)
            second_detected, second_score = detector.predict_pcm16(b"\x01\x00" * 8)

            self.assertFalse(first_detected)
            self.assertEqual(first_score, 0.1)
            self.assertTrue(second_detected)
            self.assertEqual(second_score, 0.7)
            self.assertEqual(fake_model.calls, 2)
            self.assertEqual(fake_model.resets, 1)
            self.assertEqual(fake_model.last_chunk_size, 8)

    def test_speech_gate_uses_silero_vad_after_rms_filter(self) -> None:
        class FakeAudio:
            sample_rate = 16000
            sample_width = 2

            def get_raw_data(self, *args, **kwargs):
                return (b"\x01\x02" * 16000)

        config = ActivityConfig()
        config.vad_enabled = True
        controller = self.make_speech_controller(config)
        calls = 0

        def fake_vad(_audio):
            nonlocal calls
            calls += 1
            return False

        controller._has_voice_activity = fake_vad  # type: ignore[method-assign]

        self.assertFalse(controller._should_transcribe(FakeAudio(), min_rms=1))
        self.assertEqual(calls, 1)

    def test_speech_gate_skips_vad_when_rms_is_too_low(self) -> None:
        class FakeAudio:
            sample_rate = 16000
            sample_width = 2

            def get_raw_data(self, *args, **kwargs):
                return (b"\x00\x00" * 16000)

        config = ActivityConfig()
        config.vad_enabled = True
        controller = self.make_speech_controller(config)
        controller._has_voice_activity = lambda _audio: self.fail("VAD should not run for silent audio")  # type: ignore[method-assign]

        self.assertFalse(controller._should_transcribe(FakeAudio(), min_rms=1))

    def test_vad_preload_failure_blocks_speech_after_asr_preload(self) -> None:
        config = ActivityConfig()
        config.vad_enabled = True
        config.wakeword_engine_enabled = False
        controller = self.make_speech_controller(config)
        calls: list[str] = []

        def fake_asr():
            calls.append("asr")
            return object()

        def fake_vad():
            calls.append("vad")
            raise RuntimeError("vad unavailable")

        controller._ensure_model_loaded = fake_asr  # type: ignore[method-assign]
        controller._ensure_vad_loaded = fake_vad  # type: ignore[method-assign]

        self.assertFalse(controller.preload_model())
        self.assertEqual(calls, ["asr", "vad"])
        self.assertIn("vad unavailable", controller._last_error)

    def test_vad_failure_blocks_transcription(self) -> None:
        class FakeAudio:
            sample_rate = 16000
            sample_width = 2

            def get_raw_data(self, *args, **kwargs):
                return (b"\x01\x02" * 16000)

        config = ActivityConfig()
        controller = self.make_speech_controller(config)

        def fake_vad():
            raise RuntimeError("vad failed")

        controller._ensure_vad_loaded = fake_vad  # type: ignore[method-assign]

        self.assertFalse(controller._should_transcribe(FakeAudio(), min_rms=1))
        self.assertIn("vad failed", controller._last_error)

    def test_config_forces_vad_enabled(self) -> None:
        config = ActivityConfig()
        config.update({"vad_enabled": False})

        self.assertTrue(config.vad_enabled)

    def test_speech_defaults_are_quiet_and_mic_friendly(self) -> None:
        config = ActivityConfig()

        self.assertFalse(config.debug_wake)
        self.assertEqual(config.min_energy_threshold, 100)
        self.assertEqual(config.min_wake_audio_rms, 80)

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

    def test_stop_cleans_capture_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.screenshot = False
            config.collectors.clipboard = False
            config.collectors.active_window = False
            config.collectors.accessibility = False
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            capture_folder = config.captures_dir / "capture-1"
            capture_folder.mkdir(parents=True)
            (capture_folder / "event.json").write_text("{}", encoding="utf-8")
            (config.captures_dir / "loose.txt").write_text("capture", encoding="utf-8")

            daemon.stop()

            self.assertTrue(config.captures_dir.exists())
            self.assertEqual(list(config.captures_dir.iterdir()), [])

    def test_start_cleans_stale_capture_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.screenshot = False
            config.collectors.clipboard = False
            config.collectors.active_window = False
            config.collectors.accessibility = False
            config.collectors.speech = False
            config.collectors.mouse = False
            stale_folder = config.captures_dir / "stale-capture"
            stale_folder.mkdir(parents=True)
            (stale_folder / "event.json").write_text("{}", encoding="utf-8")
            daemon = ActivityDaemon(config)

            daemon.start()

            self.assertTrue(config.captures_dir.exists())
            self.assertEqual(list(config.captures_dir.iterdir()), [])

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
            self.assertFalse(event["text"]["selection_clipboard_restored"])
            self.assertTrue(event["privacy"]["captured"]["selection_text"])

    def test_snapshot_without_drag_does_not_promote_old_clipboard_to_selection(self) -> None:
        class FakeClipboard:
            def refresh(self) -> None:
                return None

            def snapshot(self):
                return {"clipboard_text": "old clipboard", "primary_selection_text": "old primary"}

        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.screenshot = False
            config.collectors.active_window = False
            config.collectors.accessibility = False
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            daemon.clipboard = FakeClipboard()

            event = daemon.capture_snapshot(trigger="voice_screenshot")

            self.assertEqual(event["text"]["clipboard_text"], "old clipboard")
            self.assertEqual(event["text"]["primary_selection_text"], "old primary")
            self.assertEqual(event["text"]["selection_text"], "")
            self.assertIsNone(event["text"]["selection_text_source"])

    def test_drag_snapshot_does_not_fall_back_to_old_clipboard_when_copy_fails(self) -> None:
        class FakeClipboard:
            def capture_selected_text_via_copy(self, timeout_seconds: float, preserve_clipboard: bool):
                return {
                    "selection_text": "",
                    "method": "keyboard_copy",
                    "clipboard_restored": True,
                    "last_error": None,
                }

            def refresh(self) -> None:
                return None

            def snapshot(self):
                return {"clipboard_text": "old clipboard", "primary_selection_text": "old primary"}

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

            self.assertEqual(event["text"]["clipboard_text"], "old clipboard")
            self.assertEqual(event["text"]["primary_selection_text"], "old primary")
            self.assertEqual(event["text"]["selection_text"], "")
            self.assertEqual(event["text"]["selection_text_source"], "keyboard_copy")
            self.assertFalse(event["privacy"]["captured"]["selection_text"])

    def test_unarmed_drag_selection_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            captured = False

            def fake_capture_snapshot(**kwargs):
                nonlocal captured
                captured = True
                return {
                    "id": "event-1",
                    "files": {"event_json": "event.json"},
                    "text": {"selection_text": "dragged text"},
                }

            daemon.capture_snapshot = fake_capture_snapshot  # type: ignore[method-assign]
            daemon.handle_selection((10, 10), (100, 20))

            self.assertFalse(captured)
            self.assertEqual(daemon.last_selection_status["accepted"], False)
            self.assertEqual(daemon.last_selection_status["armed"], False)

    def test_armed_drag_selection_captures_and_copies(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            captured: dict[str, object] = {}

            def fake_capture_snapshot(**kwargs):
                captured.update(kwargs)
                return {
                    "id": "event-1",
                    "files": {"event_json": "event.json"},
                    "text": {"selection_text": "dragged text"},
                }

            daemon.capture_snapshot = fake_capture_snapshot  # type: ignore[method-assign]
            daemon.arm_next_selection("hey bee")
            daemon.handle_selection((10, 10), (100, 20))

            self.assertEqual(captured["trigger"], "voice_selection")
            self.assertEqual(captured["drag_start"], (10, 10))
            self.assertEqual(captured["drag_end"], (100, 20))
            self.assertEqual(captured["include_cursor_crop"], False)
            self.assertEqual(captured["include_selection_crop"], False)
            self.assertEqual(daemon.last_selection_status["accepted"], True)
            self.assertEqual(daemon.last_selection_status["armed"], True)
            self.assertFalse(daemon.get_capture_armed())

    def test_drag_selection_waits_for_pending_spoken_input(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            captured: dict[str, object] = {}

            def fake_capture_snapshot(**kwargs):
                captured.update(kwargs)
                captured["spoken_input"] = daemon.last_spoken_input
                return {
                    "id": "event-1",
                    "files": {"event_json": "event.json"},
                    "text": {"selection_text": "dragged text"},
                }

            daemon.capture_snapshot = fake_capture_snapshot  # type: ignore[method-assign]
            daemon.arm_next_selection("[input pending]", input_pending=True)
            thread = threading.Thread(target=daemon.handle_selection, args=((10, 10), (100, 20)))
            thread.start()
            time.sleep(0.05)

            self.assertEqual(captured, {})

            daemon.resolve_spoken_input("summarize this")
            thread.join(timeout=2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(captured["trigger"], "voice_selection")
            self.assertEqual(captured["spoken_input"], "summarize this")

    def test_arm_next_selection_broadcasts_voice_wake(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            events: list[dict[str, object]] = []
            daemon._broadcast = lambda event: events.append(event)  # type: ignore[method-assign]

            daemon.arm_next_selection("hey bee")

            self.assertEqual(events[0]["trigger"], "voice_wake")
            self.assertEqual(events[0]["spoken_input"], "hey bee")

    def test_suppressed_speech_does_not_broadcast_voice_wake(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            events: list[dict[str, object]] = []
            daemon._broadcast = lambda event: events.append(event)  # type: ignore[method-assign]

            lease = daemon.suppress_speech_input("browser voice input", ttl_seconds=30)
            result = daemon.arm_next_selection("hey bee", trigger="voice_wake")

            self.assertEqual(result["armed"], False)
            self.assertEqual(result["suppressed"], True)
            self.assertEqual(events, [])

            daemon.release_speech_input(lease["token"])
            result = daemon.arm_next_selection("hey bee", trigger="voice_wake")

            self.assertEqual(result["armed"], True)
            self.assertEqual(events[0]["trigger"], "voice_wake")

    def test_armed_timeout_falls_back_to_screenshot(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.armed_timeout_seconds = 0.2
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            captures: list[dict[str, object]] = []

            def fake_capture_snapshot(**kwargs):
                captures.append(kwargs)
                return {
                    "id": "event-1",
                    "files": {"event_json": "event.json"},
                    "text": {"selection_text": ""},
                }

            daemon.capture_snapshot = fake_capture_snapshot  # type: ignore[method-assign]
            daemon.arm_next_selection("hey bee")
            self.assertTrue(daemon.get_capture_armed())
            daemon.stop_event.wait(0.5)

            self.assertEqual(captures[0]["trigger"], "voice_screenshot")
            self.assertEqual(captures[0]["include_full_screen"], True)
            self.assertEqual(captures[0]["include_cursor_crop"], False)
            self.assertEqual(captures[0]["include_selection_crop"], False)
            self.assertFalse(daemon.get_capture_armed())

    def test_resolved_standalone_spoken_input_waits_for_screenshot_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.armed_timeout_seconds = 0.2
            config.collectors.speech = False
            config.collectors.mouse = False
            config.collectors.active_window = False
            daemon = ActivityDaemon(config)
            captures: list[dict[str, object]] = []
            events: list[dict[str, object]] = []

            daemon.capture_snapshot = lambda **kwargs: captures.append(kwargs) or {}  # type: ignore[method-assign]
            daemon._broadcast = lambda event: events.append(event)  # type: ignore[method-assign]

            daemon.arm_next_selection("[input pending]", trigger="voice_wake", input_pending=True)
            daemon.resolve_spoken_input("write a program for binary search")
            daemon.stop_event.wait(0.5)

            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0]["trigger"], "voice_screenshot")
            self.assertEqual(captures[0]["include_full_screen"], True)
            self.assertEqual([event.get("trigger") for event in events].count("voice_transcript"), 0)
            self.assertFalse(daemon.get_capture_armed())

    def test_same_utterance_spoken_input_waits_for_screenshot_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.armed_timeout_seconds = 0.2
            config.collectors.speech = False
            config.collectors.mouse = False
            config.collectors.active_window = False
            daemon = ActivityDaemon(config)
            captures: list[dict[str, object]] = []
            events: list[dict[str, object]] = []

            daemon.capture_snapshot = lambda **kwargs: captures.append(kwargs) or {}  # type: ignore[method-assign]
            daemon._broadcast = lambda event: events.append(event)  # type: ignore[method-assign]

            daemon.arm_next_selection("write a program for binary search", trigger="voice_wake", input_pending=False)
            daemon.stop_event.wait(0.5)

            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0]["trigger"], "voice_screenshot")
            self.assertEqual(captures[0]["include_full_screen"], True)
            self.assertEqual([event.get("trigger") for event in events].count("voice_transcript"), 0)
            self.assertFalse(daemon.get_capture_armed())

    def test_contextual_spoken_input_waits_for_screenshot_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.armed_timeout_seconds = 0.2
            config.collectors.speech = False
            config.collectors.mouse = False
            config.collectors.active_window = False
            daemon = ActivityDaemon(config)
            captures: list[dict[str, object]] = []
            events: list[dict[str, object]] = []

            daemon.capture_snapshot = lambda **kwargs: captures.append(kwargs) or {}  # type: ignore[method-assign]
            daemon._broadcast = lambda event: events.append(event)  # type: ignore[method-assign]

            daemon.arm_next_selection("[input pending]", trigger="voice_wake", input_pending=True)
            daemon.resolve_spoken_input("summarize this")
            daemon.stop_event.wait(0.5)

            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0]["trigger"], "voice_screenshot")
            self.assertEqual(captures[0]["include_full_screen"], True)
            self.assertEqual([event.get("trigger") for event in events].count("voice_transcript"), 0)
            self.assertFalse(daemon.get_capture_armed())

    def test_vague_spoken_input_waits_for_screenshot_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.armed_timeout_seconds = 0.2
            config.collectors.speech = False
            config.collectors.mouse = False
            config.collectors.active_window = False
            daemon = ActivityDaemon(config)
            captures: list[dict[str, object]] = []
            events: list[dict[str, object]] = []

            daemon.capture_snapshot = lambda **kwargs: captures.append(kwargs) or {}  # type: ignore[method-assign]
            daemon._broadcast = lambda event: events.append(event)  # type: ignore[method-assign]

            daemon.arm_next_selection("[input pending]", trigger="voice_wake", input_pending=True)
            daemon.resolve_spoken_input("how about you")
            daemon.stop_event.wait(0.5)

            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0]["trigger"], "voice_screenshot")
            self.assertEqual(captures[0]["include_full_screen"], True)
            self.assertEqual([event.get("trigger") for event in events].count("voice_transcript"), 0)
            self.assertFalse(daemon.get_capture_armed())

    def test_armed_timeout_captures_screenshot_while_spoken_input_is_pending(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            config = ActivityConfig(data_dir=temp_dir)
            config.armed_timeout_seconds = 0.2
            config.collectors.speech = False
            config.collectors.mouse = False
            daemon = ActivityDaemon(config)
            captures: list[dict[str, object]] = []

            def fake_capture_snapshot(**kwargs):
                captures.append({
                    **kwargs,
                    "spoken_input": daemon.last_spoken_input,
                })
                return {
                    "id": "event-1",
                    "files": {"event_json": "event.json"},
                    "text": {"selection_text": ""},
                }

            daemon.capture_snapshot = fake_capture_snapshot  # type: ignore[method-assign]
            daemon.arm_next_selection("[input pending]", trigger="voice_wake", input_pending=True)
            daemon.stop_event.wait(0.35)
            self.assertEqual(len(captures), 1)
            self.assertEqual(captures[0]["trigger"], "voice_screenshot")
            self.assertEqual(captures[0]["include_full_screen"], True)
            self.assertGreater(captures[0]["wait_for_spoken_input_before_publish_seconds"], 0)
            self.assertEqual(captures[0]["spoken_input"], "[input pending]")

            daemon.resolve_spoken_input("can you explain this")
            daemon.stop_event.wait(0.3)

            self.assertEqual(len(captures), 1)
            self.assertFalse(daemon.get_capture_armed())

    def test_hover_candidate_fires_after_mouse_is_still(self) -> None:
        collector = InputEventCollector(
            on_selection=lambda _start, _end: None,
            on_stop=lambda: None,
            on_hover=lambda _position: None,
            hover_delay_seconds=0.1,
            hover_cooldown_seconds=1.0,
            hover_min_move_pixels=10,
        )

        collector.record_position(10, 20)
        collector._last_move_at -= 0.2

        self.assertEqual(collector._hover_candidate(), (10, 20))
        self.assertIsNone(collector._hover_candidate())

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
