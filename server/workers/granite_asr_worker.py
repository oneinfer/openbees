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

DEFAULT_MODEL_NAME = "ibm-granite/granite-4.0-1b-speech"
MODEL_NAME = os.environ.get("GRANITE_ASR_MODEL", DEFAULT_MODEL_NAME)
DEVICE = os.environ.get("GRANITE_ASR_DEVICE") or os.environ.get("QWEN_ASR_DEVICE", "cpu")
DTYPE = os.environ.get("GRANITE_ASR_DTYPE") or os.environ.get("QWEN_ASR_DTYPE", "float32")
MAX_NEW_TOKENS = int(os.environ.get("GRANITE_ASR_MAX_NEW_TOKENS") or os.environ.get("QWEN_ASR_MAX_NEW_TOKENS", "200"))
SAMPLE_RATE = 16000

_processor: Any | None = None
_tokenizer: Any | None = None
_model: Any | None = None
_torch: Any | None = None
_device: str | None = None
_resolved_dtype_name: str | None = None


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
    for module_name in ("torch", "torchaudio", "soundfile", "transformers"):
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


def _resolve_device(torch: Any) -> str:
    requested = str(DEVICE or "auto").strip().lower()
    if requested in {"", "auto"}:
        return "cuda" if torch.cuda.is_available() else "cpu"
    if requested.startswith("cuda") and not torch.cuda.is_available():
        print(f"CUDA requested as {requested}, but CUDA is not available; falling back to cpu", file=sys.stderr)
        return "cpu"
    return requested


def _torch_dtype(torch: Any, device: str) -> Any:
    requested = str(DTYPE or "auto").strip().lower()
    if requested in {"", "auto"}:
        requested = "bfloat16" if str(device).startswith("cuda") else "float32"
    if device == "cpu" and requested in {"bfloat16", "float16"}:
        requested = "float32"
    dtype = getattr(torch, requested, None)
    if dtype is None:
        raise WorkerError(f"Unknown torch dtype: {DTYPE}", code="invalid_dtype")
    return dtype


def _dtype_name(dtype: Any) -> str:
    return str(dtype).replace("torch.", "")


def _get_model() -> tuple[Any, Any, Any, str]:
    global _processor, _tokenizer, _model, _torch, _device, _resolved_dtype_name
    if _model is not None and _processor is not None and _tokenizer is not None and _torch is not None and _device:
        return _processor, _tokenizer, _model, _device

    try:
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
    except Exception as exc:
        raise WorkerError(f"Could not import Granite ASR dependencies: {exc}", code="missing_dependency") from exc

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
        device = _resolve_device(torch)
        dtype = _torch_dtype(torch, device)
        processor = AutoProcessor.from_pretrained(MODEL_NAME)
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            MODEL_NAME,
            torch_dtype=dtype,
        )
        model.to(device)
        model.eval()
    except Exception as exc:
        raise WorkerError(f"Could not load Granite ASR model: {exc}", code="model_load_failed") from exc

    _torch = torch
    _processor = processor
    _tokenizer = processor.tokenizer
    _model = model
    _device = device
    _resolved_dtype_name = _dtype_name(dtype)
    return _processor, _tokenizer, _model, _device


def _load_audio(audio_path: str) -> Any:
    try:
        import torch
        import soundfile as sf
        import torchaudio
    except Exception as exc:
        raise WorkerError(f"Could not import audio dependencies: {exc}", code="missing_dependency") from exc

    try:
        audio_array, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
        wav = torch.from_numpy(audio_array).transpose(0, 1)
    except Exception as exc:
        raise WorkerError(f"Could not decode audio file: {exc}", code="audio_decode_failed") from exc

    if wav.numel() == 0:
        raise WorkerError("Audio file is empty", code="empty_audio")
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    if sample_rate != SAMPLE_RATE:
        wav = torchaudio.functional.resample(wav, sample_rate, SAMPLE_RATE)
    wav = wav.squeeze(0).to(torch.float32)
    if wav.shape[-1] < SAMPLE_RATE // 2:  # minimum 0.5 seconds at 16kHz
        raise WorkerError("Audio recording is too short to transcribe (minimum 0.5 seconds)", code="audio_too_short")
    return wav


def _build_prompt(tokenizer: Any, language: str | None) -> str:
    task = "Write only the exact English words spoken in the audio. Do not add, remove, or guess words."
    chat = [{"role": "user", "content": f"<|audio|>{task}"}]
    return tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)


def _transcribe(audio_path: Any, language: Any = None) -> dict[str, Any]:
    if not isinstance(audio_path, str) or not audio_path:
        raise WorkerError("audioPath is required", code="invalid_request")
    if not os.path.isfile(audio_path):
        raise WorkerError("Audio file does not exist", code="audio_not_found")

    processor, tokenizer, model, device = _get_model()
    wav = _load_audio(audio_path)
    requested_language = language.strip() if isinstance(language, str) and language.strip() else None
    prompt = _build_prompt(tokenizer, requested_language)

    try:
        model_inputs = processor(prompt, wav, device=device, return_tensors="pt").to(device)
        model_outputs = model.generate(
            **model_inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
            num_beams=1,
        )
        num_input_tokens = model_inputs["input_ids"].shape[-1]
        new_tokens = model_outputs[0, num_input_tokens:].unsqueeze(0)
        output_text = tokenizer.batch_decode(
            new_tokens,
            add_special_tokens=False,
            skip_special_tokens=True,
        )[0]
    except Exception as exc:
        raise WorkerError(f"Granite ASR transcription failed: {exc}", code="transcription_failed") from exc

    return {
        "text": str(output_text or "").strip(),
        "language": requested_language,
    }


def _load_result() -> dict[str, Any]:
    _health()
    _get_model()
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": _device or DEVICE,
        "dtype": _resolved_dtype_name or DTYPE,
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
            _result(request_id, _load_result())
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
