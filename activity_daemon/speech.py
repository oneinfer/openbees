from __future__ import annotations

import audioop
from datetime import datetime, timezone
import difflib
import io
import json
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable
import wave

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
ASR_FRAGMENT_WAKE_WORDS = {
    "bee",
    "bees",
    "beez",
    "peace",
    "piece",
    "please",
    "base",
    "rip",
    "rib",
    "rep",
}
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
    "check",
    "could",
    "create",
    "describe",
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
    "fix",
    "read",
    "analyze",
    "use",
    "do",
    "take",
    "what",
    "why",
    "how",
    "who",
    "where",
    "when",
}
NOISE_COMMAND_TRANSCRIPTS = {
    "a",
    "an",
    "the",
    "oh",
    "okay",
    "ok",
    "um",
    "uh",
    "hmm",
    "hm",
    "ah",
    "eh",
    "i",
    "i m",
    "im",
    "i am",
    "okay let s get it",
    "let s get it",
}
INCOMPLETE_COMMAND_TRANSCRIPTS = {
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

    if relaxed and normalized in ASR_FRAGMENT_WAKE_WORDS:
        return f"asr-fragment wake: {normalized}"

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


def meaningful_spoken_input(text: str) -> str:
    normalized = normalize_spoken_text(text)
    if not normalized or normalized in NOISE_COMMAND_TRANSCRIPTS or normalized in INCOMPLETE_COMMAND_TRANSCRIPTS:
        return ""
    return normalized


def has_command_body(command: str) -> bool:
    words = command.split()
    if len(words) <= 1:
        return False
    if words[0] in {"can", "could"}:
        return len(words) >= 4
    if words[0] == "please":
        return len(words) >= 3
    if words[0] == "i" and len(words) >= 3 and words[1] in {"want", "need", "would", "can"}:
        return len(words) >= 4
    return True


def command_like_spoken_input(text: str, *, allow_any_meaningful: bool = False) -> str:
    command = meaningful_spoken_input(text)
    if not command:
        return ""

    words = command.split()
    if not words:
        return ""
    if not has_command_body(command):
        return ""
    if words[0] in COMMAND_STARTERS_AFTER_WAKE:
        return command
    if words[0] == "please" and len(words) >= 2:
        return command
    if words[0] == "i" and len(words) >= 3 and words[1] in {"want", "need", "would", "can"}:
        return command
    if allow_any_meaningful:
        return command
    return ""


def command_has_explicit_intent(command: str) -> bool:
    words = command.split()
    if not words:
        return False
    if words[0] in COMMAND_STARTERS_AFTER_WAKE:
        return True
    return words[0] == "please" or (words[0] == "i" and len(words) >= 3 and words[1] in {"want", "need", "would", "can"})


def confirmed_wake_spoken_input(text: str) -> str:
    return command_like_spoken_input(text, allow_any_meaningful=True)


def merge_spoken_input_prefix(prefix: str, suffix: str) -> str:
    prefix = meaningful_spoken_input(prefix)
    suffix = meaningful_spoken_input(suffix)
    if not prefix:
        return suffix
    if not suffix:
        return prefix
    if prefix == suffix or suffix in prefix:
        return prefix
    if prefix in suffix:
        return suffix

    prefix_words = prefix.split()
    suffix_words = suffix.split()
    if prefix_words and suffix_words and prefix_words[-1] in {"a", "an", "the"} and suffix_words[0] in {"a", "an", "the"}:
        suffix_words = suffix_words[1:]

    max_overlap = min(len(prefix_words), len(suffix_words))
    for overlap in range(max_overlap, 0, -1):
        if prefix_words[-overlap:] == suffix_words[:overlap]:
            return " ".join(prefix_words + suffix_words[overlap:]).strip()

    return " ".join(prefix_words + suffix_words).strip()


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
            return command_like_spoken_input(normalized[len(wake_word):].strip(), allow_any_meaningful=True)

        marker = f" {wake_word} "
        index = normalized.find(marker)
        if index >= 0:
            return command_like_spoken_input(normalized[index + len(marker):].strip(), allow_any_meaningful=True)

    words = normalized.split()
    if words and words[0] in {"hey", "hay", "hi"}:
        bee_like_words = {"b", "be", "bee", "bees", "beez", "peace", "piece", "please", "base", "beast"}
        for index, word in enumerate(words[1:4], start=1):
            if word in bee_like_words:
                return command_like_spoken_input(" ".join(words[index + 1:]).strip(), allow_any_meaningful=True)

    confused_wake = confused_wake_prefix(normalized)
    if confused_wake is not None:
        if normalized == confused_wake:
            return ""
        return command_like_spoken_input(normalized[len(confused_wake):].strip(), allow_any_meaningful=True)

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

    def reset(self) -> None:
        if not self.config.wakeword_engine_enabled:
            return
        model = self._ensure_model_loaded()
        reset = getattr(model, "reset", None)
        if callable(reset):
            reset()

    def predict_pcm16(self, raw_data: bytes) -> tuple[bool, float]:
        if not self.config.wakeword_engine_enabled:
            return False, 0.0

        try:
            import numpy as np

            model = self._ensure_model_loaded()
            audio = np.frombuffer(raw_data, dtype=np.int16)
            if audio.size == 0:
                self._record_result(False, 0.0)
                return False, 0.0

            chunk_size = int(self.config.wakeword_chunk_size)
            if audio.size < chunk_size:
                audio = np.pad(audio, (0, chunk_size - audio.size))
            elif audio.size > chunk_size:
                audio = audio[:chunk_size]

            model_name = self._resolve_model_name(model)
            prediction = model.predict(audio)
            score = float(prediction.get(model_name, 0.0))
            detected = score >= float(self.config.wakeword_threshold)
            self._record_result(detected, score)
            if detected:
                self.reset()
            return detected, score
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
        self._asr_inference_lock = threading.Lock()
        self._wakeword_detector = OpenWakeWordDetector(config)
        self._vad_model = None
        self._vad_lock = threading.Lock()
        self._vad_last_error: str | None = None
        self._vad_last_speech_seconds: float = 0.0
        self._vad_last_timestamps: list[dict[str, int]] = []
        self._last_gate_reason = ""
        self._last_gate_log_at = 0.0
        self._last_listening_log_at = 0.0
        self._last_wake_score_log_at = 0.0
        self._debug_audio_lock = threading.Lock()
        self._debug_audio_counter = 0

    def availability(self) -> dict[str, object]:
        try:
            import speech_recognition  # noqa: F401
            import pyaudio  # noqa: F401
            import torch  # noqa: F401
            import torchaudio  # noqa: F401
            import soundfile  # noqa: F401
            import transformers  # noqa: F401
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
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

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

        processor = AutoProcessor.from_pretrained(self.config.asr_model_id)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            self.config.asr_model_id,
            torch_dtype=dtype,
        )
        model.to(device_map)
        model.eval()
        generation_config = getattr(model, "generation_config", None)
        if generation_config is not None:
            generation_config.temperature = None
            if generation_config.pad_token_id is None:
                generation_config.pad_token_id = generation_config.eos_token_id
        self._mark_status("ASR model loaded")
        return {
            "processor": processor,
            "tokenizer": processor.tokenizer,
            "model": model,
            "device": device_map,
        }

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

    def _debug_wakeword_score(self, score: float) -> None:
        if not self.config.debug_wake:
            return
        if not self.config.debug_wake_scores and score < float(self.config.wakeword_threshold):
            return
        now = time.monotonic()
        if now - self._last_wake_score_log_at < 0.5:
            return
        self._last_wake_score_log_at = now
        print(
            "[activity-daemon][speech] "
            f"openWakeWord score {score:.3f} "
            f"(threshold={self.config.wakeword_threshold:.2f})",
            flush=True,
        )

    def _audio_stats(self, audio_data) -> tuple[int, float]:
        raw_data = audio_data.get_raw_data()
        if not raw_data:
            return 0, 0.0
        rms = audioop.rms(raw_data, audio_data.sample_width)
        duration = len(raw_data) / (audio_data.sample_rate * audio_data.sample_width)
        return rms, duration

    def _debug_audio_dir(self) -> Path:
        configured = str(getattr(self.config, "speech_debug_audio_dir", "") or "").strip()
        if configured:
            return Path(configured).expanduser()
        return self.config.root / "audio-debug"

    def _debug_audio_category(self, stage: str) -> str:
        normalized = stage.lower()
        if normalized.startswith("wakeword_") or normalized.startswith("wake_"):
            return "hey-bee-trigger"
        if normalized.startswith("command_"):
            return "command-asr-inputs"
        return "activity-daemon-other"

    def _next_debug_audio_path(self, stage: str, suffix: str = ".wav") -> Path:
        safe_stage = re.sub(r"[^a-zA-Z0-9_.-]+", "_", stage).strip("_") or "audio"
        with self._debug_audio_lock:
            self._debug_audio_counter += 1
            counter = self._debug_audio_counter
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        return self._debug_audio_dir() / self._debug_audio_category(stage) / f"{timestamp}_{counter:04d}_{safe_stage}{suffix}"

    def _save_debug_audio_data(
        self,
        stage: str,
        audio_data,
        metadata: dict[str, Any] | None = None,
        *,
        convert_rate: int | None = None,
        convert_width: int | None = None,
    ) -> Path | None:
        if not getattr(self.config, "speech_debug_save_audio", False):
            return None

        try:
            debug_dir = self._debug_audio_dir()
            debug_dir.mkdir(parents=True, exist_ok=True)
            audio_path = self._next_debug_audio_path(stage)
            audio_path.parent.mkdir(parents=True, exist_ok=True)
            wav_data = audio_data.get_wav_data(convert_rate=convert_rate, convert_width=convert_width)
            audio_path.write_bytes(wav_data)

            rms, duration = self._audio_stats(audio_data)
            raw_data = audio_data.get_raw_data()
            details = {
                "stage": stage,
                "category": self._debug_audio_category(stage),
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "wav_path": str(audio_path),
                "source_sample_rate": int(getattr(audio_data, "sample_rate", 0) or 0),
                "source_sample_width": int(getattr(audio_data, "sample_width", 0) or 0),
                "source_raw_bytes": len(raw_data),
                "source_duration_seconds": round(duration, 3),
                "source_rms": int(rms),
                "wav_convert_rate": convert_rate,
                "wav_convert_width": convert_width,
            }
            if metadata:
                details.update(metadata)
            audio_path.with_suffix(".json").write_text(json.dumps(details, indent=2), encoding="utf-8")
            print(f"[activity-daemon][speech] saved debug audio {stage}: {audio_path}", flush=True)
            return audio_path
        except Exception as error:
            self._last_error = f"Failed to save debug audio: {error}"
            print(f"[activity-daemon][speech] {self._last_error}", flush=True)
            return None

    def _save_debug_pcm16_data(
        self,
        stage: str,
        raw_data: bytes,
        metadata: dict[str, Any] | None = None,
        *,
        sample_rate: int = 16000,
        sample_width: int = 2,
        channels: int = 1,
    ) -> Path | None:
        if not getattr(self.config, "speech_debug_save_audio", False):
            return None

        try:
            debug_dir = self._debug_audio_dir()
            debug_dir.mkdir(parents=True, exist_ok=True)
            pcm_path = self._next_debug_audio_path(stage, ".pcm16")
            pcm_path.parent.mkdir(parents=True, exist_ok=True)
            pcm_path.write_bytes(raw_data)

            wav_path = pcm_path.with_suffix(".wav")
            with wave.open(str(wav_path), "wb") as wav_file:
                wav_file.setnchannels(channels)
                wav_file.setsampwidth(sample_width)
                wav_file.setframerate(sample_rate)
                wav_file.writeframes(raw_data)

            frame_bytes = max(1, channels * sample_width)
            frame_count = len(raw_data) // frame_bytes
            details = {
                "stage": stage,
                "category": self._debug_audio_category(stage),
                "saved_at": datetime.now(timezone.utc).isoformat(),
                "pcm16_path": str(pcm_path),
                "wav_path": str(wav_path),
                "sample_rate": int(sample_rate),
                "sample_width": int(sample_width),
                "channels": int(channels),
                "raw_bytes": len(raw_data),
                "samples_per_channel": frame_count,
                "duration_seconds": round(frame_count / sample_rate, 3) if sample_rate > 0 else 0,
                "rms": int(audioop.rms(raw_data, sample_width)) if raw_data else 0,
            }
            if metadata:
                details.update(metadata)
            pcm_path.with_suffix(".json").write_text(json.dumps(details, indent=2), encoding="utf-8")
            print(f"[activity-daemon][speech] saved debug pcm16 {stage}: {pcm_path}", flush=True)
            return pcm_path
        except Exception as error:
            self._last_error = f"Failed to save debug PCM audio: {error}"
            print(f"[activity-daemon][speech] {self._last_error}", flush=True)
            return None

    def _update_debug_audio_metadata(self, audio_path: Path | None, metadata: dict[str, Any]) -> None:
        if audio_path is None:
            return

        try:
            metadata_path = audio_path.with_suffix(".json")
            existing: dict[str, Any] = {}
            if metadata_path.exists():
                existing = json.loads(metadata_path.read_text(encoding="utf-8"))
            existing.update(metadata)
            metadata_path.write_text(json.dumps(existing, indent=2), encoding="utf-8")
        except Exception as error:
            print(f"[activity-daemon][speech] failed to update debug metadata: {error}", flush=True)

    def _should_transcribe(self, audio_data, min_rms: int, label: str) -> bool:
        rms, duration = self._audio_stats(audio_data)
        if rms < min_rms or duration < self.config.min_audio_seconds:
            self._last_gate_reason = f"RMS/duration gate rejected audio (rms={rms}, duration={duration:.2f}s)"
            self._save_debug_audio_data(
                f"{label}_gate_rejected_source",
                audio_data,
                {"gate": "rms_duration", "min_rms": int(min_rms), "min_audio_seconds": float(self.config.min_audio_seconds)},
            )
            return False
        accepted = self._has_voice_activity(audio_data, label)
        if accepted:
            self._last_gate_reason = (
                f"Silero VAD accepted audio ({self._vad_last_speech_seconds:.2f}s speech, "
                f"rms={rms}, duration={duration:.2f}s)"
            )
        else:
            self._last_gate_reason = f"Silero VAD rejected audio (no speech detected, rms={rms}, duration={duration:.2f}s)"
        return accepted

    def _has_voice_activity(self, audio_data, label: str) -> bool:
        try:
            model = self._ensure_vad_loaded()
            from silero_vad import get_speech_timestamps
            import torch

            raw_data = audio_data.get_raw_data(convert_rate=16000, convert_width=2)
            debug_metadata = {
                "vad_sample_rate": 16000,
                "vad_sample_width": 2,
                "vad_threshold": float(self.config.vad_threshold),
                "vad_min_speech_duration_ms": int(self.config.vad_min_speech_duration_ms),
                "vad_min_silence_duration_ms": int(self.config.vad_min_silence_duration_ms),
                "vad_speech_pad_ms": int(self.config.vad_speech_pad_ms),
            }
            self._save_debug_pcm16_data(
                f"{label}_vad_input_pcm16",
                raw_data,
                {
                    **debug_metadata,
                    "handoff": "exact bytes passed to Silero VAD after speech_recognition conversion",
                },
            )
            if not raw_data:
                self._vad_last_speech_seconds = 0.0
                self._vad_last_timestamps = []
                self._save_debug_audio_data(
                    f"{label}_vad_empty",
                    audio_data,
                    {**debug_metadata, "vad_accepted": False, "vad_reason": "empty_audio"},
                    convert_rate=16000,
                    convert_width=2,
                )
                return False

            waveform = torch.frombuffer(bytearray(raw_data), dtype=torch.int16).float() / 32768.0
            if waveform.numel() == 0:
                self._vad_last_speech_seconds = 0.0
                self._vad_last_timestamps = []
                self._save_debug_audio_data(
                    f"{label}_vad_empty_waveform",
                    audio_data,
                    {**debug_metadata, "vad_accepted": False, "vad_reason": "empty_waveform"},
                    convert_rate=16000,
                    convert_width=2,
                )
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
            self._save_debug_audio_data(
                f"{label}_vad_{'accepted' if normalized_timestamps else 'rejected'}",
                audio_data,
                {
                    **debug_metadata,
                    "vad_accepted": bool(normalized_timestamps),
                    "vad_speech_seconds": self._vad_last_speech_seconds,
                    "vad_timestamps": normalized_timestamps,
                },
                convert_rate=16000,
                convert_width=2,
            )
            return bool(normalized_timestamps)
        except Exception as error:
            self._vad_last_error = str(error)
            self._last_error = f"Silero VAD failed: {error}"
            self._mark_status(self._last_error)
            self._save_debug_audio_data(
                f"{label}_vad_error",
                audio_data,
                {"vad_accepted": False, "vad_error": str(error)},
                convert_rate=16000,
                convert_width=2,
            )
            return False

    def _transcribe_audio(self, audio_data, label: str = "audio", *, save_debug: bool = True) -> str:
        # Feed the WAV bytes to Granite ASR directly from memory instead of a
        # temp-file round trip (write + read + delete) to shave latency off
        # every transcription.
        wav_bytes = audio_data.get_wav_data()
        debug_asr_path = (
            self._save_debug_audio_data(
                f"{label}_asr_input",
                audio_data,
                {"handoff": "WAV bytes handed in-memory to Granite ASR transcription"},
            )
            if save_debug else None
        )

        try:
            transcript = self._run_granite_transcription(io.BytesIO(wav_bytes)).strip().lower()
            self._update_debug_audio_metadata(
                debug_asr_path,
                {"transcript": transcript},
            )
            return transcript
        except Exception as error:
            self._update_debug_audio_metadata(
                debug_asr_path,
                {"transcription_error": str(error)},
            )
            if self._should_retry_on_cpu(error):
                self._mark_status(f"ASR inference failed on {self._resolved_device_map}/{self._resolved_dtype}: {error}; retrying on cpu/float32")
                self._reset_model_for_cpu_float32()
                transcript = self._run_granite_transcription(io.BytesIO(wav_bytes)).strip().lower()
                self._update_debug_audio_metadata(
                    debug_asr_path,
                    {"transcript_after_cpu_retry": transcript},
                )
                return transcript
            raise

    def _command_from_wake_audio(self, wake_audio) -> str:
        wake_text = self._transcribe_audio(wake_audio, "wake_audio_command_check", save_debug=False)
        self._last_wake_text = wake_text or self._last_wake_text
        command = command_after_wake_phrase(wake_text, self.config.wake_phrase)
        if command is None and wake_text:
            command = command_like_spoken_input(wake_text, allow_any_meaningful=False)
        else:
            command = command_like_spoken_input(command or "", allow_any_meaningful=True)
        if self.config.debug_wake and wake_text and not command:
            self._mark_status(f"ignored non-command wake audio transcript: {wake_text}")
        return command

    def _run_granite_transcription(self, audio_source: str | io.BytesIO) -> str:
        import torch
        import soundfile as sf
        import torchaudio

        with self._asr_inference_lock:
            runtime = self._ensure_model_loaded()
            processor = runtime["processor"]
            tokenizer = runtime["tokenizer"]
            model = runtime["model"]
            device = runtime["device"]

            audio_array, sample_rate = sf.read(audio_source, dtype="float32", always_2d=True)
            wav = torch.from_numpy(audio_array).transpose(0, 1)
            if wav.numel() == 0:
                return ""
            if wav.shape[0] > 1:
                wav = wav.mean(dim=0, keepdim=True)
            if sample_rate != 16000:
                wav = torchaudio.functional.resample(wav, sample_rate, 16000)
            wav = wav.squeeze(0).to(torch.float32)

            chat = [{"role": "user", "content": "<|audio|>Write only the exact English words spoken in the audio. Do not add, remove, or guess words."}]
            prompt = tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
            model_inputs = processor(prompt, wav, device=device, return_tensors="pt").to(device)

            with torch.no_grad():
                model_outputs = model.generate(
                    **model_inputs,
                    max_new_tokens=self.config.asr_max_new_tokens,
                    do_sample=False,
                    num_beams=1,
                )

            num_input_tokens = model_inputs["input_ids"].shape[-1]
            new_tokens = model_outputs[0, num_input_tokens:].unsqueeze(0)
            return tokenizer.batch_decode(
                new_tokens,
                add_special_tokens=False,
                skip_special_tokens=True,
            )[0]

    def transcribe_file(self, audio_path: str, language: str | None = None) -> dict[str, Any]:
        started = time.perf_counter()
        text = self._run_granite_transcription(audio_path).strip()
        return {
            "text": text,
            "language": language,
            "durationMs": int((time.perf_counter() - started) * 1000),
            "source": "activity-daemon",
        }

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

    def _listen_for_openwakeword_stream(self) -> tuple[bool, float, Any | None]:
        import pyaudio
        import speech_recognition as sr

        chunk_size = int(self.config.wakeword_chunk_size)
        audio = pyaudio.PyAudio()
        stream = None
        self._wakeword_detector.reset()
        try:
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=16000,
                input=True,
                frames_per_buffer=chunk_size,
            )
            while not self.stop_event.is_set():
                if self.is_input_suppressed_callback() or self.is_armed_callback():
                    return False, 0.0, None

                raw_data = stream.read(chunk_size, exception_on_overflow=False)
                detected, score = self._wakeword_detector.predict_pcm16(raw_data)
                self._debug_wakeword_score(score)
                if detected:
                    self._save_debug_pcm16_data(
                        "wakeword_detected_chunk_pcm16",
                        raw_data,
                        {
                            "handoff": "exact 16 kHz int16 chunk passed to openWakeWord when detection fired",
                            "wakeword_score": float(score),
                            "wakeword_threshold": float(self.config.wakeword_threshold),
                            "wakeword_chunk_size": int(chunk_size),
                        },
                    )
                    buffered_audio = bytearray(raw_data)
                    post_chunks = int((16000 * float(self.config.wakeword_post_capture_seconds)) / chunk_size)
                    for _ in range(max(0, post_chunks)):
                        if self.stop_event.is_set() or self.is_input_suppressed_callback() or self.is_armed_callback():
                            break
                        buffered_audio.extend(stream.read(chunk_size, exception_on_overflow=False))
                    self._save_debug_pcm16_data(
                        "wakeword_detected_buffer_pcm16",
                        bytes(buffered_audio),
                        {
                            "handoff": "wake-word chunk plus post-capture audio used as wake_audio",
                            "wakeword_score": float(score),
                            "wakeword_threshold": float(self.config.wakeword_threshold),
                            "wakeword_chunk_size": int(chunk_size),
                            "wakeword_post_capture_seconds": float(self.config.wakeword_post_capture_seconds),
                        },
                    )
                    wake_audio = sr.AudioData(bytes(buffered_audio), 16000, 2)
                    self._save_debug_audio_data(
                        "wakeword_detected_buffer",
                        wake_audio,
                        {
                            "wakeword_score": float(score),
                            "wakeword_threshold": float(self.config.wakeword_threshold),
                            "wakeword_chunk_size": int(chunk_size),
                            "wakeword_post_capture_seconds": float(self.config.wakeword_post_capture_seconds),
                        },
                    )
                    return True, score, wake_audio
        finally:
            if stream is not None:
                try:
                    stream.stop_stream()
                except Exception:
                    pass
                try:
                    stream.close()
                except Exception:
                    pass
            audio.terminate()

        return False, 0.0, None

    def _loop(self) -> None:
        try:
            import speech_recognition as sr

            recognizer = sr.Recognizer()
            recognizer.dynamic_energy_threshold = True
            recognizer.pause_threshold = float(getattr(self.config, "command_pause_threshold_seconds", 2.0))
            recognizer.non_speaking_duration = 0.4
            microphone = sr.Microphone()

            with microphone as source:
                self._mark_status("calibrating microphone noise")
                recognizer.adjust_for_ambient_noise(source, duration=1)
                recognizer.energy_threshold = max(int(recognizer.energy_threshold * 1.5), self.config.min_energy_threshold)
                recognizer.dynamic_energy_threshold = False
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
                    recognizer.energy_threshold = max(int(recognizer.energy_threshold), self.config.min_energy_threshold)
                    wake_text = ""
                    wake_audio = None
                    if self.config.wakeword_engine_enabled:
                        try:
                            detected, score, wake_audio = self._listen_for_openwakeword_stream()
                        except Exception as error:
                            self._last_error = f"openWakeWord stream failed: {error}"
                            self._mark_status(self._last_error)
                            detected = False
                            score = 0.0
                            wake_audio = None

                        if detected:
                            self._last_wake_text = f"{self.config.wake_phrase} score={score:.4f}"
                            wake_match = f"openWakeWord score {score:.4f}"
                            self._mark_status(f"wake word detected: {self.config.wake_phrase} (score {score:.4f})")
                        else:
                            if self.stop_event.is_set():
                                continue
                            if self.is_input_suppressed_callback():
                                self._mark_status("ignored wake candidate while browser recorder is active")
                                continue
                            if self.is_armed_callback():
                                continue
                            if not self.config.wakeword_asr_fallback_enabled:
                                continue
                            if self.config.debug_wake:
                                self._mark_status(
                                    "openWakeWord did not produce a detection; "
                            "checking wake audio with Granite ASR fallback"
                                )
                            with microphone as source:
                                wake_audio = recognizer.listen(source, timeout=2, phrase_time_limit=4)
                            if not self._should_transcribe(wake_audio, self.config.min_wake_audio_rms, "wake_fallback"):
                                self._debug_gate_skip("wake audio")
                                continue
                            self._debug_voice_activity("wake audio accepted by required Silero VAD")
                            wake_text = self._transcribe_audio(wake_audio, "wake_fallback")
                            self._last_wake_text = wake_text
                            if self.is_input_suppressed_callback():
                                self._mark_status("ignored wake candidate while browser recorder is active")
                                continue
                            if self.config.debug_wake:
                                self._mark_status(f"heard wake fallback candidate: {wake_text or '[empty]'}")
                            wake_match = wake_word_match_reason(wake_text, self.config.wake_phrase, self.config.wake_match_mode)
                    else:
                        with microphone as source:
                            wake_audio = recognizer.listen(source, timeout=2, phrase_time_limit=4)

                        if not self._should_transcribe(wake_audio, self.config.min_wake_audio_rms, "wake_phrase"):
                            self._debug_gate_skip("wake audio")
                            continue

                        self._debug_voice_activity("wake audio accepted by required Silero VAD")
                        if self.config.debug_wake:
                            print("[activity-daemon][speech] transcribing wake audio with Granite ASR", flush=True)
                        wake_text = self._transcribe_audio(wake_audio, "wake_phrase")
                        self._last_wake_text = wake_text
                        if self.is_input_suppressed_callback():
                            self._mark_status("ignored wake candidate while browser recorder is active")
                            continue

                        if self.config.debug_wake:
                            self._mark_status(f"heard wake candidate: {wake_text or '[empty]'}")
                        wake_match = wake_word_match_reason(wake_text, self.config.wake_phrase, self.config.wake_match_mode)
                    if not wake_match:
                        if self.config.debug_wake:
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

                    can_check_wake_audio = (
                        same_utterance_command is None
                        and wake_audio is not None
                        and self.config.wakeword_engine_enabled
                        and wake_match.startswith("openWakeWord")
                    )

                    command_audio = None
                    try:
                        with microphone as source:
                            phrase_limit = float(self.config.command_phrase_time_limit_seconds)
                            command_audio = recognizer.listen(
                                source,
                                timeout=float(self.config.command_listen_timeout_seconds),
                                phrase_time_limit=phrase_limit if phrase_limit > 0 else None,
                            )
                    except sr.WaitTimeoutError:
                        pass

                    if command_audio is None and can_check_wake_audio:
                        try:
                            self._mark_status("wake matched; checking wake audio for spoken task input")
                            same_utterance_command = self._command_from_wake_audio(wake_audio)
                            if same_utterance_command:
                                self._last_command_text = same_utterance_command
                                self._mark_status(f"captured spoken input from wake audio: {same_utterance_command}")
                                self.spoken_input_callback(same_utterance_command)
                                continue
                        except Exception as error:
                            self._last_error = f"Wake word heard; wake-audio command transcription failed: {error}"
                            self._mark_status("wake matched; wake-audio command transcription failed, listening for spoken task input")

                    if command_audio is None:
                        self._last_error = "Wake word heard; no spoken input followed. Waiting for selection."
                        self.spoken_input_callback("[input pending]")
                        self._mark_status("wake matched; no follow-up speech, waiting for selection")
                        continue

                    command_min_rms = min(self.config.min_command_audio_rms, max(60, int(recognizer.energy_threshold * 0.25)))
                    if not self._should_transcribe(command_audio, command_min_rms, "command"):
                        self._debug_gate_skip("command audio")
                        if can_check_wake_audio:
                            try:
                                self._mark_status("command audio rejected; checking wake audio for spoken task input")
                                same_utterance_command = self._command_from_wake_audio(wake_audio)
                                if same_utterance_command:
                                    self._last_command_text = same_utterance_command
                                    self._mark_status(f"captured spoken input from wake audio: {same_utterance_command}")
                                    self.spoken_input_callback(same_utterance_command)
                                    continue
                            except Exception as error:
                                self._last_error = f"Wake word heard; wake-audio command transcription failed: {error}"
                        self._last_error = "Wake word heard; follow-up input was too quiet or too short. Waiting for selection."
                        self.spoken_input_callback("[input pending]")
                        self._mark_status("wake matched; follow-up speech too quiet, waiting for selection")
                        continue

                    self._debug_voice_activity("command audio accepted by required Silero VAD")
                    print("[activity-daemon][speech] transcribing command audio with Granite ASR", flush=True)
                    raw_spoken_input = self._transcribe_audio(command_audio, "command")
                    spoken_input = confirmed_wake_spoken_input(raw_spoken_input)
                    should_check_wake_prefix = (
                        can_check_wake_audio
                        and raw_spoken_input
                        and (not spoken_input or not command_has_explicit_intent(spoken_input))
                    )
                    if should_check_wake_prefix:
                        try:
                            self._mark_status("checking wake audio for clipped spoken task prefix")
                            wake_spoken_input = self._command_from_wake_audio(wake_audio)
                            if wake_spoken_input:
                                spoken_input = merge_spoken_input_prefix(wake_spoken_input, spoken_input)
                        except Exception as error:
                            self._last_error = f"Wake word heard; wake-audio command transcription failed: {error}"
                    self._last_command_text = spoken_input or raw_spoken_input
                    if spoken_input:
                        self._mark_status(f"captured spoken input: {spoken_input}")
                        self.spoken_input_callback(spoken_input)
                    else:
                        if raw_spoken_input:
                            self._mark_status(f"ignored non-command transcript: {raw_spoken_input}")
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
