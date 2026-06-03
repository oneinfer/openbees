from __future__ import annotations

import audioop
from datetime import datetime, timezone
import difflib
import os
from pathlib import Path
import re
import tempfile
import threading
import time
from typing import Any, Callable

from .config import ActivityConfig


WAKE_WORDS = (
    "hey bees",
    "hey beez",
    "hey bee",
    "hay bees",
    "hay bee",
    "hey peace",
    "hey piece",
    "hey please",
    "hey base",
    "hey beast",
    "hey be",
    "hey, b.",
    "hey bitch",
    "hello",
)
SHORT_WAKE_WORDS = ("a d", "ad")
RELAXED_WAKE_VARIANTS = {
    "a b",
    "ab",
    "a, b.",
    "a b.",
    "h b",
    "hb",
    "e b",
    "eb",
    "h v",
    "hv",
    "h, v.",
    "h v.",
}
STRICT_FALSE_POSITIVES = {"a b", "ab", "abc", "abyss"}
ASR_CONFUSED_WAKE_PREFIXES = (
    "have we",
    "heavy",
    "happy",
    "hey we",
    "hay we",
)
RISKY_ASR_CONFUSED_WAKE_PREFIXES = (
    "so we",
)
COMMAND_STARTERS_AFTER_WAKE = {
    "can",
    "could",
    "create",
    "make",
    "build",
    "open",
    "show",
    "find",
    "search",
    "write",
    "draft",
    "summarize",
    "explain",
    "tell",
    "help",
}


def normalize_spoken_text(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", text.lower())).strip()


def wake_word_match_reason(text: str, wake_phrase: str | None = None, match_mode: str = "relaxed") -> str | None:
    normalized = normalize_spoken_text(text)
    compact = normalized.replace(" ", "")
    relaxed = str(match_mode or "relaxed").strip().lower() != "strict"

    if not normalized:
        return None

    configured_wakes = []
    if wake_phrase:
        configured = normalize_spoken_text(wake_phrase)
        if configured:
            configured_wakes.append(configured)

    for wake_word in SHORT_WAKE_WORDS:
        normalized_wake = normalize_spoken_text(wake_word)
        if normalized == normalized_wake or compact == normalized_wake.replace(" ", ""):
            return f"short wake: {normalized_wake}"

    if relaxed and (normalized in RELAXED_WAKE_VARIANTS or compact in RELAXED_WAKE_VARIANTS):
        return f"variant: {normalized}"

    if normalized in STRICT_FALSE_POSITIVES or compact in STRICT_FALSE_POSITIVES:
        return None

    if relaxed:
        confused_wake = confused_wake_prefix(normalized)
        if confused_wake is not None:
            return f"asr-confused wake: {confused_wake}"

    for normalized_wake in configured_wakes + [normalize_spoken_text(wake_word) for wake_word in WAKE_WORDS]:
        if normalized == normalized_wake or normalized_wake in normalized:
            return f"phrase: {normalized_wake}"

    words = normalized.split()
    if words and words[0] in {"hey", "hay", "hi"}:
        bee_like_words = {"b", "be", "bee", "bees", "beez", "peace", "piece", "please", "base", "beast"}
        if any(word in bee_like_words for word in words[1:]):
            return f"bee-like phrase: {normalized}"

    if len(compact) < 5:
        return None

    wake_compacts = ("heybees", "heybee", "haybees", "haybee", "heypeace", "heypiece")
    for wake in wake_compacts:
        if difflib.SequenceMatcher(None, compact, wake).ratio() >= 0.72:
            return f"fuzzy: {normalized}"
    return None


def confused_wake_prefix(normalized: str) -> str | None:
    for wake_prefix in ASR_CONFUSED_WAKE_PREFIXES:
        if normalized == wake_prefix or normalized.startswith(f"{wake_prefix} "):
            return wake_prefix

    for wake_prefix in RISKY_ASR_CONFUSED_WAKE_PREFIXES:
        if normalized == wake_prefix:
            return wake_prefix
        if normalized.startswith(f"{wake_prefix} "):
            remainder = normalized[len(wake_prefix):].strip()
            first_word = remainder.split(maxsplit=1)[0] if remainder else ""
            if first_word in COMMAND_STARTERS_AFTER_WAKE:
                return wake_prefix

    return None


def contains_wake_word(text: str, wake_phrase: str | None = None, match_mode: str = "relaxed") -> bool:
    return wake_word_match_reason(text, wake_phrase, match_mode) is not None


def command_after_wake_phrase(text: str, wake_phrase: str | None = None) -> str | None:
    normalized = normalize_spoken_text(text)
    if not normalized:
        return None

    wake_variants = []
    if wake_phrase:
        configured = normalize_spoken_text(wake_phrase)
        if configured:
            wake_variants.append(configured)
    wake_variants.extend(normalize_spoken_text(wake_word) for wake_word in WAKE_WORDS)

    for wake_word in sorted(set(wake_variants), key=len, reverse=True):
        if not wake_word:
            continue
        if normalized == wake_word:
            return ""
        if normalized.startswith(f"{wake_word} "):
            return normalized[len(wake_word):].strip()

        marker = f" {wake_word} "
        index = normalized.find(marker)
        if index >= 0:
            return normalized[index + len(marker):].strip()

    words = normalized.split()
    if words and words[0] in {"hey", "hay", "hi"}:
        bee_like_words = {"b", "be", "bee", "bees", "beez", "peace", "piece", "please", "base", "beast"}
        for index, word in enumerate(words[1:4], start=1):
            if word in bee_like_words:
                return " ".join(words[index + 1:]).strip()

    confused_wake = confused_wake_prefix(normalized)
    if confused_wake is not None:
        if normalized == confused_wake:
            return ""
        return normalized[len(confused_wake):].strip()

    return None


class OpenWakeWordDetector:
    def __init__(self, config: ActivityConfig, model_factory: Callable[..., Any] | None = None) -> None:
        self.config = config
        self._model_factory = model_factory
        self._model = None
        self._model_lock = threading.Lock()
        self._model_name = ""
        self._last_error: str | None = None
        self._last_score = 0.0
        self._last_detected = False
        self._last_event_at: str | None = None

    def availability(self) -> dict[str, object]:
        available = True
        error = self._last_error
        if self.config.wakeword_engine_enabled:
            try:
                import openwakeword  # noqa: F401
                import onnxruntime  # noqa: F401
            except Exception as import_error:
                available = False
                error = str(import_error)

            model_path = self.model_path()
            if not model_path.exists():
                available = False
                error = f"Wake-word model not found: {model_path}"

        return {
            "enabled": bool(self.config.wakeword_engine_enabled),
            "available": available,
            "model_path": str(self.model_path()),
            "model_name": self._model_name,
            "model_loaded": self._model is not None,
            "threshold": self.config.wakeword_threshold,
            "chunk_size": self.config.wakeword_chunk_size,
            "asr_fallback_enabled": self.config.wakeword_asr_fallback_enabled,
            "last_score": self._last_score,
            "last_detected": self._last_detected,
            "last_error": error,
            "last_event_at": self._last_event_at,
        }

    def preload(self) -> bool:
        if not self.config.wakeword_engine_enabled:
            return True
        self._ensure_model_loaded()
        return True

    def model_path(self) -> Path:
        return Path(self.config.wakeword_model_path).expanduser()

    def detect(self, audio_data) -> tuple[bool, float]:
        if not self.config.wakeword_engine_enabled:
            return False, 0.0

        try:
            import numpy as np

            model = self._ensure_model_loaded()
            raw_data = audio_data.get_raw_data(convert_rate=16000, convert_width=2)
            audio = np.frombuffer(raw_data, dtype=np.int16)
            if audio.size == 0:
                self._record_result(False, 0.0)
                return False, 0.0

            reset = getattr(model, "reset", None)
            if callable(reset):
                reset()

            model_name = self._resolve_model_name(model)
            max_score = 0.0
            chunk_size = int(self.config.wakeword_chunk_size)
            for start in range(0, audio.size, chunk_size):
                chunk = audio[start:start + chunk_size]
                if chunk.size < chunk_size:
                    chunk = np.pad(chunk, (0, chunk_size - chunk.size))
                prediction = model.predict(chunk)
                max_score = max(max_score, float(prediction.get(model_name, 0.0)))

            detected = max_score >= float(self.config.wakeword_threshold)
            self._record_result(detected, max_score)
            return detected, max_score
        except Exception as error:
            self._last_error = str(error)
            self._last_detected = False
            self._last_event_at = datetime.now(timezone.utc).isoformat()
            raise

    def _ensure_model_loaded(self):
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is None:
                self._model = self._load_model()
        return self._model

    def _load_model(self):
        model_path = self.model_path()
        if not model_path.exists():
            raise FileNotFoundError(f"Wake-word model not found: {model_path}")

        if self._model_factory is not None:
            model = self._model_factory(str(model_path))
        else:
            from openwakeword.model import Model

            kwargs: dict[str, Any] = {
                "wakeword_models": [str(model_path)],
                "inference_framework": "onnx",
            }
            feature_dir = Path(__file__).resolve().parent / "models" / "openwakeword"
            melspec_path = feature_dir / "melspectrogram.onnx"
            embedding_path = feature_dir / "embedding_model.onnx"
            if melspec_path.exists() and embedding_path.exists():
                kwargs["melspec_model_path"] = str(melspec_path)
                kwargs["embedding_model_path"] = str(embedding_path)
            model = Model(**kwargs)

        self._model_name = self._resolve_model_name(model)
        self._last_error = None
        return model

    def _resolve_model_name(self, model) -> str:
        if self._model_name:
            return self._model_name
        models = getattr(model, "models", None)
        if isinstance(models, dict) and models:
            self._model_name = str(next(iter(models.keys())))
            return self._model_name
        raise RuntimeError("openWakeWord model did not expose a model name")

    def _record_result(self, detected: bool, score: float) -> None:
        self._last_detected = detected
        self._last_score = round(float(score), 4)
        self._last_error = None
        self._last_event_at = datetime.now(timezone.utc).isoformat()


class SpeechArmController:
    def __init__(
        self,
        config: ActivityConfig,
        arm_callback: Callable[..., None],
        spoken_input_callback: Callable[[str], None],
        disarm_callback: Callable[[str | None], None],
        is_armed_callback: Callable[[], bool],
        is_input_suppressed_callback: Callable[[], bool] | None,
        stop_event: threading.Event,
    ) -> None:
        self.config = config
        self.arm_callback = arm_callback
        self.spoken_input_callback = spoken_input_callback
        self.disarm_callback = disarm_callback
        self.is_armed_callback = is_armed_callback
        self.is_input_suppressed_callback = is_input_suppressed_callback or (lambda: False)
        self.stop_event = stop_event
        self._thread: threading.Thread | None = None
        self._last_error: str | None = None
        self._last_status = "not started"
        self._last_wake_text = ""
        self._last_command_text = ""
        self._last_event_at: str | None = None
        self._resolved_device_map: str | None = None
        self._resolved_dtype: str | None = None
        self._model = None
        self._model_lock = threading.Lock()
        self._wakeword_detector = OpenWakeWordDetector(config)
        self._vad_model = None
        self._vad_lock = threading.Lock()
        self._vad_last_error: str | None = None
        self._vad_last_speech_seconds: float = 0.0
        self._vad_last_timestamps: list[dict[str, int]] = []
        self._last_gate_reason = ""
        self._last_gate_log_at = 0.0
        self._last_listening_log_at = 0.0

    def availability(self) -> dict[str, object]:
        try:
            import speech_recognition  # noqa: F401
            import pyaudio  # noqa: F401
            import torch  # noqa: F401
            import qwen_asr  # noqa: F401
            import silero_vad  # noqa: F401
            wakeword_status = self._wakeword_detector.availability()
            return {
                "enabled": True,
                "available": bool(wakeword_status.get("available", True)),
                "permission_required": True,
                "last_error": self._last_error or wakeword_status.get("last_error"),
                "last_status": self._last_status,
                "last_wake_text": self._last_wake_text,
                "last_command_text": self._last_command_text,
                "last_event_at": self._last_event_at,
                "model_loaded": self._model is not None,
                "resolved_device_map": self._resolved_device_map,
                "resolved_dtype": self._resolved_dtype,
                "wakeword_engine": wakeword_status,
                "vad_enabled": True,
                "vad_available": True,
                "vad_model": "silero_vad",
                "vad_model_loaded": self._vad_model is not None,
                "vad_last_error": self._vad_last_error,
                "vad_last_speech_seconds": self._vad_last_speech_seconds,
                "vad_last_timestamps": self._vad_last_timestamps,
                "last_gate_reason": self._last_gate_reason,
            }
        except Exception as error:
            return {
                "enabled": True,
                "available": False,
                "permission_required": True,
                "last_error": str(error),
                "last_status": self._last_status,
                "last_wake_text": self._last_wake_text,
                "last_command_text": self._last_command_text,
                "last_event_at": self._last_event_at,
                "model_loaded": self._model is not None,
                "resolved_device_map": self._resolved_device_map,
                "resolved_dtype": self._resolved_dtype,
                "wakeword_engine": self._wakeword_detector.availability(),
                "vad_enabled": True,
                "vad_available": False,
                "vad_model": "silero_vad",
                "vad_model_loaded": self._vad_model is not None,
                "vad_last_error": self._vad_last_error,
                "vad_last_speech_seconds": self._vad_last_speech_seconds,
                "vad_last_timestamps": self._vad_last_timestamps,
                "last_gate_reason": self._last_gate_reason,
            }

    def preload_model(self) -> bool:
        try:
            self._mark_status("preloading wake-word model")
            self._wakeword_detector.preload()
            self._mark_status("wake-word model preloaded")
            self._ensure_model_loaded()
            self._mark_status("preloading required Silero VAD model")
            self._ensure_vad_loaded()
            self._mark_status("required Silero VAD model preloaded")
            return True
        except Exception as error:
            self._last_error = str(error)
            self._vad_last_error = str(error)
            self._mark_status(f"required Silero VAD preload failed: {error}")
            self._mark_status(f"speech model preload failed: {error}")
            return False

    def start(self) -> None:
        self._mark_status("starting speech listener")
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._thread:
            self._thread.join(timeout=2)

    def _load_asr_model(self):
        import torch
        from qwen_asr import Qwen3ASRModel

        device_map = self._resolve_device_map(torch)
        dtype = self._resolve_dtype(torch, device_map)
        self._resolved_device_map = str(device_map)
        self._resolved_dtype = self._dtype_name(dtype)
        self._mark_status(f"loading ASR model {self.config.asr_model_id} on {device_map} with {self._resolved_dtype}")

        try:
            from transformers.utils import logging as hf_logging
            hf_logging.set_verbosity_error()
        except Exception:
            pass

        model = Qwen3ASRModel.from_pretrained(
            self.config.asr_model_id,
            dtype=dtype,
            device_map=device_map,
            max_inference_batch_size=1,
            max_new_tokens=self.config.asr_max_new_tokens,
        )
        generation_config = getattr(model.model, "generation_config", None)
        if generation_config is not None:
            generation_config.temperature = None
            if generation_config.pad_token_id is None:
                generation_config.pad_token_id = generation_config.eos_token_id
        self._mark_status("ASR model loaded")
        return model

    def _load_vad_model(self):
        from silero_vad import load_silero_vad

        self._mark_status("loading Silero VAD model")
        model = load_silero_vad()
        self._mark_status("Silero VAD model loaded")
        return model

    def _resolve_device_map(self, torch_module: Any) -> str:
        requested = str(self.config.asr_device_map or "auto").strip().lower()
        if requested in {"", "auto"}:
            return "cuda:0" if torch_module.cuda.is_available() else "cpu"
        if requested.startswith("cuda") and not torch_module.cuda.is_available():
            self._mark_status(f"CUDA requested as {requested}, but CUDA is not available; falling back to cpu")
            return "cpu"
        return requested

    def _resolve_dtype(self, torch_module: Any, device_map: str):
        requested = str(self.config.asr_dtype or "auto").strip().lower()
        if requested in {"", "auto"}:
            requested = "bfloat16" if str(device_map).startswith("cuda") else "float32"
        dtype = getattr(torch_module, requested, None)
        if dtype is None:
            self._mark_status(f"Unknown ASR dtype {requested}; falling back to float32")
            return torch_module.float32
        if str(device_map) == "cpu" and requested in {"bfloat16", "float16"}:
            self._mark_status(f"ASR dtype {requested} is not reliable on cpu; falling back to float32")
            return torch_module.float32
        return dtype

    def _dtype_name(self, dtype: Any) -> str:
        return str(dtype).replace("torch.", "")

    def _ensure_model_loaded(self):
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is None:
                self._model = self._load_asr_model()
        return self._model

    def _ensure_vad_loaded(self):
        if self._vad_model is not None:
            return self._vad_model
        with self._vad_lock:
            if self._vad_model is None:
                self._vad_model = self._load_vad_model()
        return self._vad_model

    def _mark_status(self, status: str) -> None:
        self._last_status = status
        self._last_event_at = datetime.now(timezone.utc).isoformat()
        print(f"[activity-daemon][speech] {status}", flush=True)

    def _debug_gate_skip(self, label: str) -> None:
        if not self.config.debug_wake:
            return
        now = time.monotonic()
        if now - self._last_gate_log_at < 2:
            return
        self._last_gate_log_at = now
        print(f"[activity-daemon][speech] {label} skipped: {self._last_gate_reason}", flush=True)

    def _debug_voice_activity(self, label: str) -> None:
        if not self.config.debug_wake:
            return
        print(f"[activity-daemon][speech] {label}: {self._last_gate_reason}", flush=True)

    def _debug_listening_heartbeat(self, recognizer: Any) -> None:
        if not self.config.debug_wake:
            return
        now = time.monotonic()
        if now - self._last_listening_log_at < 5:
            return
        self._last_listening_log_at = now
        print(
            "[activity-daemon][speech] listening for wake audio "
            f"(energy_threshold={int(getattr(recognizer, 'energy_threshold', 0))}, "
            f"vad_loaded={self._vad_model is not None}, "
            f"wakeword_loaded={self._wakeword_detector.availability().get('model_loaded')}, "
            f"asr_loaded={self._model is not None})",
            flush=True,
        )

    def _audio_stats(self, audio_data) -> tuple[int, float]:
        raw_data = audio_data.get_raw_data()
        if not raw_data:
            return 0, 0.0
        rms = audioop.rms(raw_data, audio_data.sample_width)
        duration = len(raw_data) / (audio_data.sample_rate * audio_data.sample_width)
        return rms, duration

    def _should_transcribe(self, audio_data, min_rms: int) -> bool:
        rms, duration = self._audio_stats(audio_data)
        if rms < min_rms or duration < self.config.min_audio_seconds:
            self._last_gate_reason = f"RMS/duration gate rejected audio (rms={rms}, duration={duration:.2f}s)"
            return False
        accepted = self._has_voice_activity(audio_data)
        if accepted:
            self._last_gate_reason = f"Silero VAD accepted audio ({self._vad_last_speech_seconds:.2f}s speech)"
        else:
            self._last_gate_reason = "Silero VAD rejected audio (no speech detected)"
        return accepted

    def _has_voice_activity(self, audio_data) -> bool:
        try:
            model = self._ensure_vad_loaded()
            from silero_vad import get_speech_timestamps
            import torch

            raw_data = audio_data.get_raw_data(convert_rate=16000, convert_width=2)
            if not raw_data:
                self._vad_last_speech_seconds = 0.0
                self._vad_last_timestamps = []
                return False

            waveform = torch.frombuffer(raw_data, dtype=torch.int16).clone().float() / 32768.0
            if waveform.numel() == 0:
                self._vad_last_speech_seconds = 0.0
                self._vad_last_timestamps = []
                return False

            timestamps = get_speech_timestamps(
                waveform,
                model,
                sampling_rate=16000,
                threshold=self.config.vad_threshold,
                min_speech_duration_ms=self.config.vad_min_speech_duration_ms,
                min_silence_duration_ms=self.config.vad_min_silence_duration_ms,
                speech_pad_ms=self.config.vad_speech_pad_ms,
            )
            normalized_timestamps = [
                {
                    "start": int(segment.get("start", 0)),
                    "end": int(segment.get("end", 0)),
                }
                for segment in timestamps
            ]
            speech_samples = sum(max(0, segment["end"] - segment["start"]) for segment in normalized_timestamps)
            self._vad_last_error = None
            self._vad_last_speech_seconds = round(speech_samples / 16000, 3)
            self._vad_last_timestamps = normalized_timestamps[:8]
            return bool(normalized_timestamps)
        except Exception as error:
            self._vad_last_error = str(error)
            self._last_error = f"Silero VAD failed: {error}"
            self._mark_status(self._last_error)
            return False

    def _transcribe_audio(self, audio_data) -> str:
        model = self._ensure_model_loaded()

        fd, temp_path = tempfile.mkstemp(prefix="oneinfer_command_", suffix=".wav")
        os.close(fd)
        with open(temp_path, "wb") as f:
            f.write(audio_data.get_wav_data())

        try:
            try:
                results = model.transcribe(audio=[temp_path], language=["English"])
            except TypeError:
                results = model.transcribe(audio=temp_path, language="English")
            if not results:
                return ""
            return getattr(results[0], "text", str(results[0])).strip().lower()
        except Exception as error:
            if self._should_retry_on_cpu(error):
                self._mark_status(f"ASR inference failed on {self._resolved_device_map}/{self._resolved_dtype}: {error}; retrying on cpu/float32")
                self._reset_model_for_cpu_float32()
                model = self._ensure_model_loaded()
                results = model.transcribe(audio=temp_path, language="English")
                if not results:
                    return ""
                return getattr(results[0], "text", str(results[0])).strip().lower()
            raise
        finally:
            try:
                os.remove(temp_path)
            except OSError:
                pass

    def _should_retry_on_cpu(self, error: Exception) -> bool:
        message = str(error).lower()
        return (
            "weight should have at least three dimensions" in message
            or "meta device" in message
            or "offload" in message
        ) and not (self._resolved_device_map == "cpu" and self._resolved_dtype == "float32")

    def _reset_model_for_cpu_float32(self) -> None:
        with self._model_lock:
            self._model = None
            self.config.asr_device_map = "cpu"
            self.config.asr_dtype = "float32"
            self._resolved_device_map = None
            self._resolved_dtype = None

    def _loop(self) -> None:
        try:
            import speech_recognition as sr

            recognizer = sr.Recognizer()
            recognizer.dynamic_energy_threshold = True
            recognizer.pause_threshold = 0.8
            recognizer.non_speaking_duration = 0.4
            microphone = sr.Microphone()

            with microphone as source:
                self._mark_status("calibrating microphone noise")
                recognizer.adjust_for_ambient_noise(source, duration=1)
                recognizer.energy_threshold = max(int(recognizer.energy_threshold * 1.5), self.config.min_energy_threshold)
            self._mark_status(f"listening for wake phrase: {self.config.wake_phrase}")

            while not self.stop_event.is_set():
                try:
                    if self.is_input_suppressed_callback():
                        if self._last_status != "speech input suppressed by browser recorder":
                            self._mark_status("speech input suppressed by browser recorder")
                        time.sleep(0.2)
                        continue

                    if self.is_armed_callback():
                        time.sleep(0.2)
                        continue

                    self._debug_listening_heartbeat(recognizer)
                    with microphone as source:
                        wake_audio = recognizer.listen(source, timeout=2, phrase_time_limit=4)

                    if not self._should_transcribe(wake_audio, self.config.min_wake_audio_rms):
                        self._debug_gate_skip("wake audio")
                        continue

                    self._debug_voice_activity("wake audio accepted by required Silero VAD")
                    wake_text = ""
                    if self.config.wakeword_engine_enabled:
                        detected, score = self._wakeword_detector.detect(wake_audio)
                        self._last_wake_text = f"{self.config.wake_phrase} score={score:.4f}" if detected else ""
                        if self.is_input_suppressed_callback():
                            self._mark_status("ignored wake candidate while browser recorder is active")
                            continue
                        if not detected:
                            if not self.config.wakeword_asr_fallback_enabled:
                                self._mark_status(
                                    f"listening for wake phrase: {self.config.wake_phrase} "
                                    f"(wake-word model score {score:.4f} below threshold {self.config.wakeword_threshold:.2f})"
                                )
                                continue

                            self._mark_status(
                                "wake-word model score "
                                f"{score:.4f} below threshold {self.config.wakeword_threshold:.2f}; "
                                "checking wake audio with Qwen ASR"
                            )
                            wake_text = self._transcribe_audio(wake_audio)
                            self._last_wake_text = wake_text
                            if self.is_input_suppressed_callback():
                                self._mark_status("ignored wake candidate while browser recorder is active")
                                continue
                            self._mark_status(f"heard wake fallback candidate: {wake_text or '[empty]'}")
                            wake_match = wake_word_match_reason(wake_text, self.config.wake_phrase, self.config.wake_match_mode)
                        else:
                            wake_match = f"openWakeWord score {score:.4f}"
                    else:
                        print("[activity-daemon][speech] transcribing wake audio with Qwen ASR", flush=True)
                        wake_text = self._transcribe_audio(wake_audio)
                        self._last_wake_text = wake_text
                        if self.is_input_suppressed_callback():
                            self._mark_status("ignored wake candidate while browser recorder is active")
                            continue

                        self._mark_status(f"heard wake candidate: {wake_text or '[empty]'}")
                        wake_match = wake_word_match_reason(wake_text, self.config.wake_phrase, self.config.wake_match_mode)
                    if not wake_match:
                        self._mark_status(f"listening for wake phrase: {self.config.wake_phrase}")
                        continue

                    if not self.config.listen_for_command_after_wake:
                        self._mark_status(f"wake phrase matched via {wake_match}; armed for drag selection")
                        self.arm_callback("[input pending]", input_pending=False)
                        self._mark_status("wake matched; armed for drag selection")
                        continue

                    same_utterance_command = command_after_wake_phrase(wake_text, self.config.wake_phrase)
                    if same_utterance_command:
                        self._last_command_text = same_utterance_command
                        self._mark_status(f"captured spoken input from wake audio: {same_utterance_command}")
                        self.arm_callback(same_utterance_command, input_pending=False)
                        continue

                    self._mark_status(f"wake phrase matched via {wake_match}; listening for spoken task input")
                    self.arm_callback("[input pending]", input_pending=True)

                    if same_utterance_command is None and self.config.wakeword_engine_enabled and wake_match.startswith("openWakeWord"):
                        try:
                            self._mark_status("wake matched; checking wake audio for spoken task input")
                            wake_text = self._transcribe_audio(wake_audio)
                            self._last_wake_text = wake_text or self._last_wake_text
                            same_utterance_command = command_after_wake_phrase(wake_text, self.config.wake_phrase)
                            if same_utterance_command is None and wake_text:
                                same_utterance_command = wake_text
                            if same_utterance_command:
                                self._last_command_text = same_utterance_command
                                self._mark_status(f"captured spoken input from wake audio: {same_utterance_command}")
                                self.spoken_input_callback(same_utterance_command)
                                continue
                        except Exception as error:
                            self._last_error = f"Wake word heard; wake-audio command transcription failed: {error}"
                            self._mark_status("wake matched; wake-audio command transcription failed, listening for spoken task input")

                    try:
                        with microphone as source:
                            command_audio = recognizer.listen(source, timeout=5, phrase_time_limit=10)
                    except sr.WaitTimeoutError:
                        self._last_error = "Wake word heard; no spoken input followed. Waiting for selection."
                        self.spoken_input_callback("[input pending]")
                        self._mark_status("wake matched; no follow-up speech, waiting for selection")
                        continue

                    command_min_rms = min(self.config.min_command_audio_rms, max(60, int(recognizer.energy_threshold * 0.25)))
                    if not self._should_transcribe(command_audio, command_min_rms):
                        self._debug_gate_skip("command audio")
                        self._last_error = "Wake word heard; follow-up input was too quiet or too short. Waiting for selection."
                        self.spoken_input_callback("[input pending]")
                        self._mark_status("wake matched; follow-up speech too quiet, waiting for selection")
                        continue

                    self._debug_voice_activity("command audio accepted by required Silero VAD")
                    print("[activity-daemon][speech] transcribing command audio with Qwen ASR", flush=True)
                    spoken_input = self._transcribe_audio(command_audio)
                    self._last_command_text = spoken_input
                    if spoken_input:
                        self._mark_status(f"captured spoken input: {spoken_input}")
                        self.spoken_input_callback(spoken_input)
                    else:
                        self._last_error = "Wake word heard; no spoken input transcribed. Waiting for selection."
                        self.spoken_input_callback("[input pending]")
                        self._mark_status("wake matched; no follow-up speech transcribed, waiting for selection")
                except sr.WaitTimeoutError:
                    self._debug_listening_heartbeat(recognizer)
                    continue
                except Exception as error:
                    self._last_error = str(error)
                    self._mark_status(f"speech listener error: {error}")
                    time.sleep(1)
        except Exception as error:
            self._last_error = str(error)
            self._mark_status(f"speech listener stopped: {error}")
