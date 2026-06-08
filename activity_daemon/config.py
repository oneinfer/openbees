from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import os
from pathlib import Path
from typing import Any


def env_bool(name: str) -> bool | None:
    value = os.getenv(name)
    if value is None:
        return None
    return str(value).strip().lower() not in {"0", "false", "no", "off"}


def default_data_dir() -> Path:
    return Path(os.getenv("ONEINFER_ACTIVITY_DATA_DIR", Path.home() / ".oneinfer" / "activity-daemon")).expanduser()


def default_wakeword_model_path() -> Path:
    return Path(__file__).resolve().parent / "models" / "hey_bee.onnx"


@dataclass
class CollectorSettings:
    screenshot: bool = True
    mouse: bool = True
    speech: bool = True
    clipboard: bool = True
    active_window: bool = True
    accessibility: bool = True


@dataclass
class ActivityConfig:
    data_dir: str = field(default_factory=lambda: str(default_data_dir()))
    cursor_crop_size: int = 400
    retention_count: int = 200
    storage_mode: str = "sqlite"
    wake_phrase: str = "hey bee"
    armed_timeout_seconds: float = 10.0
    drag_threshold_pixels: int = 12
    hover_capture_enabled: bool = True
    hover_delay_seconds: float = 0.8
    hover_cooldown_seconds: float = 5.0
    hover_min_move_pixels: int = 80
    include_base64_by_default: bool = False
    copy_selection_to_extract_text: bool = True
    preserve_clipboard_after_selection_copy: bool = False
    selection_copy_timeout_seconds: float = 0.8
    listen_for_command_after_wake: bool = field(default_factory=lambda: env_bool("LISTEN_FOR_COMMAND_AFTER_WAKE") is not False)
    command_listen_timeout_seconds: float = field(default_factory=lambda: float(os.getenv("COMMAND_LISTEN_TIMEOUT_SECONDS", "5")))
    command_phrase_time_limit_seconds: float = field(default_factory=lambda: float(os.getenv("COMMAND_PHRASE_TIME_LIMIT_SECONDS", "0.0")))
    command_pause_threshold_seconds: float = field(default_factory=lambda: float(os.getenv("COMMAND_PAUSE_THRESHOLD_SECONDS", "2.0")))
    collectors: CollectorSettings = field(default_factory=CollectorSettings)
    wakeword_engine_enabled: bool = field(default_factory=lambda: env_bool("WAKEWORD_ENGINE_ENABLED") is not False)
    wakeword_model_path: str = field(default_factory=lambda: os.getenv("WAKEWORD_MODEL_PATH", str(default_wakeword_model_path())))
    wakeword_threshold: float = field(default_factory=lambda: float(os.getenv("WAKEWORD_THRESHOLD", "0.5")))
    wakeword_chunk_size: int = field(default_factory=lambda: int(os.getenv("WAKEWORD_CHUNK_SIZE", "1280")))
    wakeword_post_capture_seconds: float = field(default_factory=lambda: float(os.getenv("WAKEWORD_POST_CAPTURE_SECONDS", "0.35")))
    wakeword_asr_fallback_enabled: bool = field(default_factory=lambda: env_bool("WAKEWORD_ASR_FALLBACK_ENABLED") is not False)
    asr_model_id: str = field(default_factory=lambda: os.getenv("STT_MODEL_ID") or os.getenv("GRANITE_ASR_MODEL", "ibm-granite/granite-4.0-1b-speech"))
    asr_device_map: str = field(default_factory=lambda: os.getenv("STT_DEVICE_MAP") or os.getenv("GRANITE_ASR_DEVICE") or os.getenv("QWEN_ASR_DEVICE", "auto"))
    asr_dtype: str = field(default_factory=lambda: os.getenv("STT_DTYPE") or os.getenv("GRANITE_ASR_DTYPE") or os.getenv("QWEN_ASR_DTYPE", "auto"))
    asr_max_new_tokens: int = field(default_factory=lambda: int(os.getenv("STT_MAX_NEW_TOKENS", "96")))
    preload_asr_model: bool = field(default_factory=lambda: os.getenv("PRELOAD_ASR_MODEL", "1") == "1")
    min_energy_threshold: int = field(default_factory=lambda: int(os.getenv("MIN_ENERGY_THRESHOLD", "100")))
    min_wake_audio_rms: int = field(default_factory=lambda: int(os.getenv("MIN_WAKE_AUDIO_RMS", "80")))
    min_command_audio_rms: int = field(default_factory=lambda: int(os.getenv("MIN_COMMAND_AUDIO_RMS", "80")))
    min_audio_seconds: float = field(default_factory=lambda: float(os.getenv("MIN_AUDIO_SECONDS", "0.35")))
    vad_enabled: bool = True
    vad_threshold: float = field(default_factory=lambda: float(os.getenv("VAD_THRESHOLD", "0.5")))
    vad_min_speech_duration_ms: int = field(default_factory=lambda: int(os.getenv("VAD_MIN_SPEECH_DURATION_MS", "120")))
    vad_min_silence_duration_ms: int = field(default_factory=lambda: int(os.getenv("VAD_MIN_SILENCE_DURATION_MS", "80")))
    vad_speech_pad_ms: int = field(default_factory=lambda: int(os.getenv("VAD_SPEECH_PAD_MS", "30")))
    speech_debug_save_audio: bool = field(default_factory=lambda: env_bool("SPEECH_DEBUG_SAVE_AUDIO") is True)
    speech_debug_audio_dir: str = field(default_factory=lambda: os.getenv("SPEECH_DEBUG_AUDIO_DIR", ""))
    wake_match_mode: str = field(default_factory=lambda: os.getenv("WAKE_MATCH_MODE", "relaxed"))
    debug_wake: bool = field(default_factory=lambda: os.getenv("DEBUG_WAKE", "0") == "1")
    debug_wake_scores: bool = field(default_factory=lambda: os.getenv("DEBUG_WAKE_SCORES", "0") == "1")

    @property
    def root(self) -> Path:
        return Path(self.data_dir).expanduser()

    @property
    def images_dir(self) -> Path:
        return self.root / "images"

    @property
    def captures_dir(self) -> Path:
        return self.root / "captures"

    @property
    def database_path(self) -> Path:
        return self.root / "events.sqlite3"

    @property
    def config_path(self) -> Path:
        return self.root / "config.json"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def update(self, patch: dict[str, Any]) -> None:
        for key, value in patch.items():
            if key == "collectors" and isinstance(value, dict):
                for collector_key, collector_value in value.items():
                    if hasattr(self.collectors, collector_key):
                        setattr(self.collectors, collector_key, bool(collector_value))
                continue
            if hasattr(self, key):
                setattr(self, key, value)

        self.cursor_crop_size = max(64, min(int(self.cursor_crop_size), 2000))
        self.retention_count = max(1, min(int(self.retention_count), 10000))
        self.drag_threshold_pixels = max(1, int(self.drag_threshold_pixels))
        self.armed_timeout_seconds = max(1.0, float(self.armed_timeout_seconds))
        self.hover_capture_enabled = bool(self.hover_capture_enabled)
        self.hover_delay_seconds = max(0.1, min(float(self.hover_delay_seconds), 10.0))
        self.hover_cooldown_seconds = max(0.5, min(float(self.hover_cooldown_seconds), 120.0))
        self.hover_min_move_pixels = max(1, int(self.hover_min_move_pixels))
        self.selection_copy_timeout_seconds = max(0.1, min(float(self.selection_copy_timeout_seconds), 5.0))
        self.command_listen_timeout_seconds = max(1.0, min(float(self.command_listen_timeout_seconds), 30.0))
        self.command_phrase_time_limit_seconds = max(0.0, min(float(self.command_phrase_time_limit_seconds), 3600.0))
        self.command_pause_threshold_seconds = max(0.5, min(float(self.command_pause_threshold_seconds), 10.0))
        self.vad_enabled = True
        self.vad_threshold = max(0.01, min(float(self.vad_threshold), 0.99))
        self.vad_min_speech_duration_ms = max(0, int(self.vad_min_speech_duration_ms))
        self.vad_min_silence_duration_ms = max(0, int(self.vad_min_silence_duration_ms))
        self.vad_speech_pad_ms = max(0, int(self.vad_speech_pad_ms))
        self.speech_debug_save_audio = bool(self.speech_debug_save_audio)
        self.speech_debug_audio_dir = str(self.speech_debug_audio_dir or "")
        self.wakeword_engine_enabled = bool(self.wakeword_engine_enabled)
        self.wakeword_threshold = max(0.01, min(float(self.wakeword_threshold), 0.99))
        self.wakeword_chunk_size = max(160, int(self.wakeword_chunk_size))
        self.wakeword_post_capture_seconds = max(0.0, min(float(self.wakeword_post_capture_seconds), 5.0))
        self.wakeword_asr_fallback_enabled = bool(self.wakeword_asr_fallback_enabled)
        self.wake_match_mode = str(self.wake_match_mode or "relaxed").strip().lower()
        if self.wake_match_mode not in {"relaxed", "strict"}:
            self.wake_match_mode = "relaxed"


def load_config(config_path: str | None = None) -> ActivityConfig:
    config = ActivityConfig()
    path = Path(config_path).expanduser() if config_path else config.config_path

    if path.exists():
        with path.open("r", encoding="utf-8-sig") as f:
            config.update(json.load(f))

    env_data_dir = os.getenv("ONEINFER_ACTIVITY_DATA_DIR")
    if env_data_dir:
        config.data_dir = env_data_dir

    env_command_after_wake = env_bool("LISTEN_FOR_COMMAND_AFTER_WAKE")
    config.listen_for_command_after_wake = True if env_command_after_wake is None else env_command_after_wake
    env_command_listen_timeout = os.getenv("COMMAND_LISTEN_TIMEOUT_SECONDS")
    if env_command_listen_timeout is not None:
        config.command_listen_timeout_seconds = float(env_command_listen_timeout)
    env_command_phrase_time_limit = os.getenv("COMMAND_PHRASE_TIME_LIMIT_SECONDS")
    if env_command_phrase_time_limit is not None:
        config.command_phrase_time_limit_seconds = float(env_command_phrase_time_limit)
    env_command_pause_threshold = os.getenv("COMMAND_PAUSE_THRESHOLD_SECONDS")
    if env_command_pause_threshold is not None:
        config.command_pause_threshold_seconds = float(env_command_pause_threshold)

    if os.getenv("MIN_ENERGY_THRESHOLD") is None and int(config.min_energy_threshold) == 300:
        config.min_energy_threshold = 100
    if os.getenv("MIN_WAKE_AUDIO_RMS") is None and int(config.min_wake_audio_rms) == 180:
        config.min_wake_audio_rms = 80
    if os.getenv("WAKEWORD_POST_CAPTURE_SECONDS") is None and float(config.wakeword_post_capture_seconds) >= 2.0:
        config.wakeword_post_capture_seconds = 0.35

    env_debug_wake = env_bool("DEBUG_WAKE")
    if env_debug_wake is not None:
        config.debug_wake = env_debug_wake
    else:
        config.debug_wake = False

    env_speech_debug_audio = env_bool("SPEECH_DEBUG_SAVE_AUDIO")
    if env_speech_debug_audio is not None:
        config.speech_debug_save_audio = env_speech_debug_audio
    env_speech_debug_audio_dir = os.getenv("SPEECH_DEBUG_AUDIO_DIR")
    if env_speech_debug_audio_dir is not None:
        config.speech_debug_audio_dir = env_speech_debug_audio_dir

    config.update({})

    return config


def save_config(config: ActivityConfig) -> None:
    config.root.mkdir(parents=True, exist_ok=True)
    with config.config_path.open("w", encoding="utf-8") as f:
        json.dump(config.to_dict(), f, indent=2)
