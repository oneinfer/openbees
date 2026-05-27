from __future__ import annotations

import audioop
from datetime import datetime, timezone
import difflib
import os
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
    "hey bitch",
    "hello",
)
SHORT_WAKE_WORDS = ("a d", "ad")
RELAXED_WAKE_VARIANTS = {
    "a b",
    "ab",
    "h b",
    "hb",
    "e b",
    "eb",
}
STRICT_FALSE_POSITIVES = {"a b", "ab", "abc", "abyss"}


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

    if relaxed and (normalized in RELAXED_WAKE_VARIANTS or compact in RELAXED_WAKE_VARIANTS):
        return f"variant: {normalized}"

    for wake_word in SHORT_WAKE_WORDS:
        normalized_wake = normalize_spoken_text(wake_word)
        if normalized == normalized_wake or compact == normalized_wake.replace(" ", ""):
            return f"short wake: {normalized_wake}"

    if normalized in STRICT_FALSE_POSITIVES or compact in STRICT_FALSE_POSITIVES:
        return None

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


def contains_wake_word(text: str, wake_phrase: str | None = None, match_mode: str = "relaxed") -> bool:
    return wake_word_match_reason(text, wake_phrase, match_mode) is not None


class SpeechArmController:
    def __init__(
        self,
        config: ActivityConfig,
        arm_callback: Callable[[str], None],
        disarm_callback: Callable[[str | None], None],
        is_armed_callback: Callable[[], bool],
        stop_event: threading.Event,
    ) -> None:
        self.config = config
        self.arm_callback = arm_callback
        self.disarm_callback = disarm_callback
        self.is_armed_callback = is_armed_callback
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

    def availability(self) -> dict[str, object]:
        try:
            import speech_recognition  # noqa: F401
            import torch  # noqa: F401
            import qwen_asr  # noqa: F401
            return {
                "enabled": True,
                "available": True,
                "permission_required": True,
                "last_error": self._last_error,
                "last_status": self._last_status,
                "last_wake_text": self._last_wake_text,
                "last_command_text": self._last_command_text,
                "last_event_at": self._last_event_at,
                "model_loaded": self._model is not None,
                "resolved_device_map": self._resolved_device_map,
                "resolved_dtype": self._resolved_dtype,
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
            }

    def preload_model(self) -> bool:
        try:
            self._ensure_model_loaded()
            return True
        except Exception as error:
            self._last_error = str(error)
            self._mark_status(f"ASR model preload failed: {error}")
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

    def _mark_status(self, status: str) -> None:
        self._last_status = status
        self._last_event_at = datetime.now(timezone.utc).isoformat()
        print(f"[activity-daemon][speech] {status}", flush=True)

    def _audio_stats(self, audio_data) -> tuple[int, float]:
        raw_data = audio_data.get_raw_data()
        if not raw_data:
            return 0, 0.0
        rms = audioop.rms(raw_data, audio_data.sample_width)
        duration = len(raw_data) / (audio_data.sample_rate * audio_data.sample_width)
        return rms, duration

    def _should_transcribe(self, audio_data, min_rms: int) -> bool:
        rms, duration = self._audio_stats(audio_data)
        return rms >= min_rms and duration >= self.config.min_audio_seconds

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
                    if self.is_armed_callback():
                        time.sleep(0.2)
                        continue

                    with microphone as source:
                        wake_audio = recognizer.listen(source, timeout=2, phrase_time_limit=4)

                    if not self._should_transcribe(wake_audio, self.config.min_wake_audio_rms):
                        continue

                    wake_text = self._transcribe_audio(wake_audio)
                    self._last_wake_text = wake_text
                    self._mark_status(f"heard wake candidate: {wake_text or '[empty]'}")
                    wake_match = wake_word_match_reason(wake_text, self.config.wake_phrase, self.config.wake_match_mode)
                    if not wake_match:
                        self._mark_status(f"listening for wake phrase: {self.config.wake_phrase}")
                        continue

                    self._mark_status(f"wake phrase matched via {wake_match}; waiting for selection")
                    self.arm_callback("[input pending]")
                    if not self.config.listen_for_command_after_wake:
                        self._mark_status("wake matched; armed for drag selection")
                        continue
                    try:
                        with microphone as source:
                            command_audio = recognizer.listen(source, timeout=5, phrase_time_limit=10)
                    except sr.WaitTimeoutError:
                        self._last_error = "Wake word heard; no spoken input followed. Waiting for selection."
                        self._mark_status("wake matched; no follow-up speech, still armed for selection")
                        continue

                    if not self._should_transcribe(command_audio, self.config.min_command_audio_rms):
                        self._last_error = "Wake word heard; follow-up input was too quiet or too short. Waiting for selection."
                        self._mark_status("wake matched; follow-up speech too quiet, still armed for selection")
                        continue

                    spoken_input = self._transcribe_audio(command_audio)
                    self._last_command_text = spoken_input
                    if spoken_input:
                        self._mark_status(f"captured spoken input: {spoken_input}")
                        self.arm_callback(spoken_input)
                    else:
                        self._last_error = "Wake word heard; no spoken input transcribed. Waiting for selection."
                        self._mark_status("wake matched; no follow-up speech transcribed, still armed for selection")
                except sr.WaitTimeoutError:
                    continue
                except Exception as error:
                    self._last_error = str(error)
                    self._mark_status(f"speech listener error: {error}")
                    time.sleep(1)
        except Exception as error:
            self._last_error = str(error)
            self._mark_status(f"speech listener stopped: {error}")
