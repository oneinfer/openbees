from __future__ import annotations

import base64
import json
import os
import sys
import traceback
import types
from typing import Any

import numpy as np


def _stub_torchcodec_if_broken() -> None:
    """
    torchcodec calls load_torchcodec_shared_libraries() at module level, which
    requires FFmpeg full-shared DLLs. On Windows without them the import raises
    RuntimeError and brings down any downstream package that does `import torchcodec`.

    Strategy:
    - Each stub gets a real ModuleSpec so Python 3.12+ import machinery doesn't
      raise ImportError("X.__spec__ is None").
    - Child stubs are wired as attributes on their parent so that attribute-style
      access like `torchcodec.decoders` works without AttributeError.
    - Stub classes (AudioDecoder etc.) are installed so transformers/lhotse can do
      `isinstance(x, torchcodec.decoders.AudioDecoder)` — always returns False since
      x is never a real AudioDecoder, causing those code paths to be skipped cleanly.
    - If lhotse's TorchcodecBackend is selected and tries to instantiate AudioDecoder,
      it raises ImportError which CompositeAudioBackend catches and falls back from.
    """
    try:
        import torchcodec  # noqa: F401
        return  # loaded fine — nothing to do
    except (RuntimeError, OSError, ImportError):
        pass
    import importlib.metadata
    import importlib.machinery
    # Remove any partial state left by the failed import
    for key in [k for k in sys.modules if k == "torchcodec" or k.startswith("torchcodec.")]:
        del sys.modules[key]

    # Create all stubs with proper __spec__ and __path__
    _stubs: dict = {}
    for _name in ("torchcodec", "torchcodec._core", "torchcodec._core.ops",
                  "torchcodec._frame", "torchcodec.decoders", "torchcodec.encoders",
                  "torchcodec.samplers", "torchcodec.transforms", "torchcodec.version",
                  "torchcodec._internally_replaced_utils", "torchcodec._logging"):
        _mod = types.ModuleType(_name)
        _mod.__spec__ = importlib.machinery.ModuleSpec(_name, loader=None, is_package=True)
        _mod.__path__ = []
        sys.modules[_name] = _mod
        _stubs[_name] = _mod

    # Wire each child stub as an attribute on its parent so that attribute-style
    # access (e.g. `import torchcodec; torchcodec.decoders.AudioDecoder`) doesn't
    # raise AttributeError on the parent module.
    for _name, _mod in _stubs.items():
        if "." in _name:
            _parent, _child = _name.rsplit(".", 1)
            if _parent in _stubs:
                setattr(_stubs[_parent], _child, _mod)

    # Install sentinel classes so isinstance checks return False instead of
    # raising AttributeError.  These classes raise ImportError if instantiated
    # so any backend that tries to actually USE them falls back gracefully.
    class _UnavailableClass:
        def __init__(self, *args, **kwargs):
            raise ImportError(
                "torchcodec is not functional on this system (FFmpeg DLLs not "
                "available). This stub exists only for isinstance() checks."
            )
    for _attr in ("AudioDecoder", "VideoDecoder", "WavDecoder", "SimpleVideoDecoder"):
        setattr(_stubs["torchcodec.decoders"], _attr, _UnavailableClass)
    for _attr in ("AudioEncoder", "VideoEncoder"):
        setattr(_stubs["torchcodec.encoders"], _attr, _UnavailableClass)
    # Expose decoders/encoders/samplers on root stub (mirrors real torchcodec.__init__)
    _stubs["torchcodec"].decoders = _stubs["torchcodec.decoders"]
    _stubs["torchcodec"].encoders = _stubs["torchcodec.encoders"]
    _stubs["torchcodec"].samplers = _stubs["torchcodec.samplers"]

    # Transformers checks both importability and package metadata for torchcodec.
    # The stub is process-local, so provide matching process-local metadata too.
    _metadata_version = importlib.metadata.version

    def _version(name: str) -> str:
        if name == "torchcodec":
            return "0.0.0"
        return _metadata_version(name)

    importlib.metadata.version = _version


_stub_torchcodec_if_broken()

MODEL = None
ENCODED_PROMPT = None


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _load_model():
    global MODEL, ENCODED_PROMPT
    if MODEL is not None and ENCODED_PROMPT is not None:
        return MODEL, ENCODED_PROMPT

    reference_audio = os.environ.get("LUX_TTS_REFERENCE_AUDIO_PATH", "").strip()
    if not reference_audio:
        raise RuntimeError("LUX_TTS_REFERENCE_AUDIO_PATH is required for LuxTTS voice cloning.")
    if not os.path.exists(reference_audio):
        raise RuntimeError(f"LUX_TTS_REFERENCE_AUDIO_PATH does not exist: {reference_audio}")

    from zipvoice.luxvoice import LuxTTS

    model_name = os.environ.get("LUX_TTS_MODEL", "YatharthS/LuxTTS")
    device = os.environ.get("LUX_TTS_DEVICE", "cpu")
    threads = _env_int("LUX_TTS_THREADS", 2)

    if device == "cpu":
        MODEL = LuxTTS(model_name, device=device, threads=threads)
    else:
        MODEL = LuxTTS(model_name, device=device)
    ENCODED_PROMPT = MODEL.encode_prompt(
        reference_audio,
        duration=_env_float("LUX_TTS_REFERENCE_DURATION_SECONDS", 5.0),
        rms=_env_float("LUX_TTS_REFERENCE_RMS", 0.001),
    )
    return MODEL, ENCODED_PROMPT


def _to_numpy(wav: Any) -> np.ndarray:
    if hasattr(wav, "detach"):
        wav = wav.detach().cpu().numpy()
    elif hasattr(wav, "cpu") and hasattr(wav.cpu(), "numpy"):
        wav = wav.cpu().numpy()
    elif hasattr(wav, "numpy"):
        wav = wav.numpy()
    return np.asarray(wav).squeeze()


def _synthesize(text: str) -> dict[str, Any]:
    model, encoded_prompt = _load_model()
    final_wav = model.generate_speech(
        text,
        encoded_prompt,
        num_steps=_env_int("LUX_TTS_NUM_STEPS", 4),
        t_shift=_env_float("LUX_TTS_T_SHIFT", 0.5),
        speed=_env_float("LUX_TTS_SPEED", 1.0),
    )
    wav = _to_numpy(final_wav).astype(np.float32)
    wav = np.nan_to_num(wav, nan=0.0, posinf=0.0, neginf=0.0)
    pcm = (np.clip(wav, -1.0, 1.0) * 32767.0).astype("<i2")
    return {
        "sampleRate": 48000,
        "format": "pcm_s16le",
        "audioBase64": base64.b64encode(pcm.tobytes()).decode("ascii"),
        "sampleCount": int(pcm.shape[0]),
    }


def _result(request_id: Any, data: dict[str, Any]) -> None:
    print(json.dumps({"id": request_id, "type": "result", "data": data}), flush=True)


def _error(request_id: Any, exc: Exception) -> None:
    print(json.dumps({"id": request_id, "type": "error", "error": {"message": str(exc), "traceback": traceback.format_exc()}}), flush=True)


def handle(request: dict[str, Any]) -> None:
    request_id = request.get("id")
    try:
        request_type = request.get("type")
        if request_type == "health":
            _result(request_id, {"ok": True})
        elif request_type == "load":
            _load_model()
            _result(request_id, {"ok": True})
        elif request_type == "synthesize":
            text = str(request.get("text") or "").strip()
            if not text:
                raise ValueError("text is required")
            _result(request_id, _synthesize(text))
        else:
            raise ValueError(f"Unsupported request type: {request_type}")
    except Exception as exc:
        _error(request_id, exc)


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as exc:
            _error(None, exc)


if __name__ == "__main__":
    main()
