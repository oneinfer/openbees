from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import os
from pathlib import Path
from typing import Any


def default_data_dir() -> Path:
    return Path(os.getenv("ONEINFER_ACTIVITY_DATA_DIR", Path.home() / ".oneinfer" / "activity-daemon")).expanduser()


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
    wake_phrase: str = "hey bees"
    armed_timeout_seconds: float = 20.0
    drag_threshold_pixels: int = 12
    include_base64_by_default: bool = False
    copy_selection_to_extract_text: bool = True
    preserve_clipboard_after_selection_copy: bool = True
    selection_copy_timeout_seconds: float = 0.8
    collectors: CollectorSettings = field(default_factory=CollectorSettings)
    asr_model_id: str = field(default_factory=lambda: os.getenv("STT_MODEL_ID", "Qwen/Qwen3-ASR-0.6B"))
    asr_device_map: str = field(default_factory=lambda: os.getenv("STT_DEVICE_MAP", "auto"))
    asr_max_new_tokens: int = field(default_factory=lambda: int(os.getenv("STT_MAX_NEW_TOKENS", "96")))
    min_energy_threshold: int = field(default_factory=lambda: int(os.getenv("MIN_ENERGY_THRESHOLD", "300")))
    min_wake_audio_rms: int = field(default_factory=lambda: int(os.getenv("MIN_WAKE_AUDIO_RMS", "180")))
    min_command_audio_rms: int = field(default_factory=lambda: int(os.getenv("MIN_COMMAND_AUDIO_RMS", "180")))
    min_audio_seconds: float = field(default_factory=lambda: float(os.getenv("MIN_AUDIO_SECONDS", "0.35")))
    debug_wake: bool = field(default_factory=lambda: os.getenv("DEBUG_WAKE", "1") == "1")

    @property
    def root(self) -> Path:
        return Path(self.data_dir).expanduser()

    @property
    def images_dir(self) -> Path:
        return self.root / "images"

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
        self.selection_copy_timeout_seconds = max(0.1, min(float(self.selection_copy_timeout_seconds), 5.0))


def load_config(config_path: str | None = None) -> ActivityConfig:
    config = ActivityConfig()
    path = Path(config_path).expanduser() if config_path else config.config_path

    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            config.update(json.load(f))

    env_data_dir = os.getenv("ONEINFER_ACTIVITY_DATA_DIR")
    if env_data_dir:
        config.data_dir = env_data_dir

    return config


def save_config(config: ActivityConfig) -> None:
    config.root.mkdir(parents=True, exist_ok=True)
    with config.config_path.open("w", encoding="utf-8") as f:
        json.dump(config.to_dict(), f, indent=2)
