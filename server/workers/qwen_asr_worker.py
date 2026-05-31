from __future__ import annotations

import importlib.util
import json
import os
import sys
import traceback
import warnings
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
warnings.filterwarnings("ignore", message="PySoundFile failed.*")
warnings.filterwarnings("ignore", category=FutureWarning, module=r"librosa\..*")

MODEL_NAME = os.environ.get("QWEN_ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")
DEVICE = os.environ.get("QWEN_ASR_DEVICE", "cuda:0")
DTYPE = os.environ.get("QWEN_ASR_DTYPE", "bfloat16")
MAX_NEW_TOKENS = int(os.environ.get("QWEN_ASR_MAX_NEW_TOKENS", "512"))

_model: Any | None = None


class WorkerError(Exception):
    def __init__(self, message: str, code: str = "worker_error") -> None:
        super().__init__(message)
        self.code = code


def _write(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _result(request_id: str, data: dict[str, Any]) -> None:
    _write({"id": request_id, "type": "result", "data": data})


def _error(request_id: str, error: Exception) -> None:
    code = getattr(error, "code", "worker_error")
    _write({"id": request_id, "type": "error", "error": {"message": str(error), "code": code}})


def _health() -> dict[str, Any]:
    missing: list[str] = []
    for module_name in ("qwen_asr", "torch"):
        if importlib.util.find_spec(module_name) is None:
            missing.append(module_name)
    if missing:
        raise WorkerError(
            "Missing Python package(s): " + ", ".join(missing),
            code="missing_dependency",
        )
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "dtype": DTYPE,
    }


def _torch_dtype(torch: Any) -> Any:
    if DTYPE in {"auto", ""}:
        return "auto"
    dtype = getattr(torch, DTYPE, None)
    if dtype is None:
        raise WorkerError(f"Unknown torch dtype: {DTYPE}", code="invalid_dtype")
    return dtype


def _get_model() -> Any:
    global _model
    if _model is not None:
        return _model

    try:
        import torch
        from qwen_asr import Qwen3ASRModel
    except Exception as exc:
        raise WorkerError(f"Could not import Qwen ASR dependencies: {exc}", code="missing_dependency") from exc

    try:
        import transformers
        transformers.logging.set_verbosity_error()
    except Exception:
        pass

    try:
        from huggingface_hub.utils import logging as hf_logging
        hf_logging.set_verbosity_error()
    except Exception:
        pass

    try:
        _model = Qwen3ASRModel.from_pretrained(
            MODEL_NAME,
            dtype=_torch_dtype(torch),
            device_map=DEVICE,
            max_inference_batch_size=1,
            max_new_tokens=MAX_NEW_TOKENS,
        )
    except Exception as exc:
        raise WorkerError(f"Could not load Qwen ASR model: {exc}", code="model_load_failed") from exc

    return _model


def _field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _transcribe(audio_path: Any, language: Any = None) -> dict[str, Any]:
    if not isinstance(audio_path, str) or not audio_path:
        raise WorkerError("audioPath is required", code="invalid_request")
    if not os.path.isfile(audio_path):
        raise WorkerError("Audio file does not exist", code="audio_not_found")

    model = _get_model()
    requested_language = language if isinstance(language, str) and language.strip() else None

    try:
        results = model.transcribe(audio=audio_path, language=requested_language)
    except Exception as exc:
        raise WorkerError(f"Qwen ASR transcription failed: {exc}", code="transcription_failed") from exc

    if not results:
        return {"text": "", "language": None}

    first = results[0]
    return {
        "text": str(_field(first, "text", "") or ""),
        "language": _field(first, "language", None),
    }


def _handle(request: dict[str, Any]) -> None:
    request_id = str(request.get("id") or "")
    if not request_id:
        return

    try:
        request_type = request.get("type")
        if request_type == "health":
            _result(request_id, _health())
        elif request_type == "load":
            _health()
            _get_model()
            _result(request_id, {"ok": True, "model": MODEL_NAME, "device": DEVICE, "dtype": DTYPE})
        elif request_type == "transcribe":
            _result(request_id, _transcribe(request.get("audioPath"), request.get("language")))
        else:
            raise WorkerError(f"Unknown request type: {request_type}", code="unknown_request")
    except Exception as exc:
        print(traceback.format_exc(), file=sys.stderr)
        _error(request_id, exc)


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as exc:
            print(f"Invalid JSON request: {exc}", file=sys.stderr)
            continue
        if isinstance(request, dict):
            _handle(request)


if __name__ == "__main__":
    main()
