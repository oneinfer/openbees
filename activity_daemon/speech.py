from __future__ import annotations

import audioop
import difflib
import os
import re
import tempfile
import threading
import time
from typing import Callable

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


def normalize_spoken_text(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", text.lower())).strip()


def contains_wake_word(text: str) -> bool:
    normalized = normalize_spoken_text(text)
    compact = normalized.replace(" ", "")

    if not normalized:
        return False

    for wake_word in SHORT_WAKE_WORDS:
        normalized_wake = normalize_spoken_text(wake_word)
        if normalized == normalized_wake or compact == normalized_wake.replace(" ", ""):
            return True

    if normalized in {"a b", "ab", "abc", "abyss"} or len(compact) < 5:
        return False

    for wake_word in WAKE_WORDS:
        normalized_wake = normalize_spoken_text(wake_word)
        if normalized == normalized_wake or normalized_wake in normalized:
            return True

    words = normalized.split()
    if words and words[0] in {"hey", "hay", "hi"}:
        bee_like_words = {"b", "be", "bee", "bees", "beez", "peace", "piece", "please", "base", "beast"}
        if any(word in bee_like_words for word in words[1:]):
            return True

    wake_compacts = ("heybees", "heybee", "haybees", "haybee", "heypeace", "heypiece")
    return any(difflib.SequenceMatcher(None, compact, wake).ratio() >= 0.72 for wake in wake_compacts)


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
        self._model = None

    def availability(self) -> dict[str, object]:
        try:
            import speech_recognition  # noqa: F401
            import torch  # noqa: F401
            import qwen_asr  # noqa: F401
            return {"enabled": True, "available": True, "permission_required": True, "last_error": self._last_error}
        except Exception as error:
            return {"enabled": True, "available": False, "permission_required": True, "last_error": str(error)}

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._thread:
            self._thread.join(timeout=2)

    def _load_asr_model(self):
        import torch
        from qwen_asr import Qwen3ASRModel

        try:
            from transformers.utils import logging as hf_logging
            hf_logging.set_verbosity_error()
        except Exception:
            pass

        model = Qwen3ASRModel.from_pretrained(
            self.config.asr_model_id,
            dtype=torch.bfloat16,
            device_map=self.config.asr_device_map,
            max_inference_batch_size=1,
            max_new_tokens=self.config.asr_max_new_tokens,
        )
        generation_config = getattr(model.model, "generation_config", None)
        if generation_config is not None:
            generation_config.temperature = None
            if generation_config.pad_token_id is None:
                generation_config.pad_token_id = generation_config.eos_token_id
        return model

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
        if self._model is None:
            self._model = self._load_asr_model()

        fd, temp_path = tempfile.mkstemp(prefix="oneinfer_command_", suffix=".wav")
        os.close(fd)
        with open(temp_path, "wb") as f:
            f.write(audio_data.get_wav_data())

        try:
            try:
                results = self._model.transcribe(audio=[temp_path], language=["English"])
            except TypeError:
                results = self._model.transcribe(audio=temp_path, language="English")
            if not results:
                return ""
            return getattr(results[0], "text", str(results[0])).strip().lower()
        finally:
            try:
                os.remove(temp_path)
            except OSError:
                pass

    def _loop(self) -> None:
        try:
            import speech_recognition as sr

            recognizer = sr.Recognizer()
            recognizer.dynamic_energy_threshold = True
            recognizer.pause_threshold = 0.8
            recognizer.non_speaking_duration = 0.4
            microphone = sr.Microphone()

            with microphone as source:
                recognizer.adjust_for_ambient_noise(source, duration=1)
                recognizer.energy_threshold = max(int(recognizer.energy_threshold * 1.5), self.config.min_energy_threshold)

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
                    if not contains_wake_word(wake_text):
                        continue

                    self.arm_callback("[input pending]")
                    try:
                        with microphone as source:
                            command_audio = recognizer.listen(source, timeout=5, phrase_time_limit=10)
                    except sr.WaitTimeoutError:
                        self.disarm_callback("No input after wake word.")
                        continue

                    if not self._should_transcribe(command_audio, self.config.min_command_audio_rms):
                        self.disarm_callback("Input was too quiet or too short.")
                        continue

                    spoken_input = self._transcribe_audio(command_audio)
                    if spoken_input:
                        self.arm_callback(spoken_input)
                    else:
                        self.disarm_callback("No input heard.")
                except sr.WaitTimeoutError:
                    continue
                except Exception as error:
                    self._last_error = str(error)
                    time.sleep(1)
        except Exception as error:
            self._last_error = str(error)
