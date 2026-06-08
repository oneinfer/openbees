import os
import tempfile
import time
import traceback
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any

import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from transformers.feature_extraction_utils import FeatureExtractionMixin

from stt import INDEX_HTML


MODEL_ID = os.getenv("GRANITE_ASR_MODEL_ID", "ibm-granite/granite-4.0-1b-speech")
DEVICE = os.getenv("GRANITE_ASR_DEVICE", "auto")
TORCH_DTYPE = os.getenv("GRANITE_ASR_TORCH_DTYPE", "auto")
MAX_NEW_TOKENS = int(os.getenv("GRANITE_ASR_MAX_NEW_TOKENS", "200"))
PROMPT = os.getenv(
    "GRANITE_ASR_PROMPT",
    "<|audio|>Write only the exact English words spoken in the audio. Do not add, remove, or guess words.",
)
HOST = os.getenv("GRANITE_ASR_HOST", "127.0.0.1")
PORT = int(os.getenv("GRANITE_ASR_PORT", "8003"))
TARGET_SAMPLE_RATE = int(os.getenv("GRANITE_ASR_SAMPLE_RATE", "16000"))

app_state: dict[str, Any] = {}
model_lock = Lock()
job_lock = Lock()


class TorchGraniteSpeechFeatureExtractor(FeatureExtractionMixin):
    model_input_names = ["input_features"]

    def __init__(
        self,
        torch_module: Any,
        sampling_rate: int = 16000,
        n_fft: int = 512,
        win_length: int = 400,
        hop_length: int = 160,
        n_mels: int = 80,
        projector_window_size: int = 15,
        projector_downsample_rate: int = 5,
        **kwargs: Any,
    ):
        super().__init__(**kwargs)
        self.torch = torch_module
        self.sampling_rate = sampling_rate
        self.n_fft = n_fft
        self.win_length = win_length
        self.hop_length = hop_length
        self.n_mels = n_mels
        self.projector_window_size = projector_window_size
        self.projector_downsample_rate = projector_downsample_rate
        self.mel_filters = self._build_mel_filters()
        self.window = self.torch.hann_window(self.win_length)

    def __call__(self, audios: Any, device: str | None = "cpu") -> dict[str, Any]:
        tensors, audio_lengths = self._coerce_audios(audios)
        features = [self._extract_one(audio) for audio in tensors]
        input_features = self.torch.nn.utils.rnn.pad_sequence(
            features,
            batch_first=True,
            padding_value=0.0,
        )
        if device is not None:
            input_features = input_features.to(device)

        audio_embed_sizes = self._get_num_audio_features(audio_lengths)
        mask = self.torch.arange(max(audio_embed_sizes), device=input_features.device).view(1, -1)
        mask = mask < self.torch.tensor(audio_embed_sizes, device=input_features.device).view(-1, 1)
        return {
            "input_features": input_features,
            "audio_embed_sizes": audio_embed_sizes,
            "input_features_mask": mask,
        }

    def _coerce_audios(self, audios: Any) -> tuple[list[Any], list[int]]:
        import numpy as np

        if isinstance(audios, np.ndarray):
            audios = [audios]
        elif self.torch.is_tensor(audios):
            audios = [audios]
        elif not isinstance(audios, list):
            audios = list(audios)

        tensors = []
        lengths = []
        for audio in audios:
            if isinstance(audio, np.ndarray):
                audio = self.torch.from_numpy(audio)
            audio = audio.squeeze().to(self.torch.float32)
            if audio.ndim != 1:
                raise ValueError("Audio must be mono after loading.")
            tensors.append(audio.cpu())
            lengths.append(audio.shape[-1])
        return tensors, lengths

    def _extract_one(self, audio: Any) -> Any:
        spectrogram = self.torch.stft(
            audio,
            n_fft=self.n_fft,
            hop_length=self.hop_length,
            win_length=self.win_length,
            window=self.window,
            center=True,
            pad_mode="reflect",
            normalized=False,
            onesided=True,
            return_complex=True,
        )
        power_spec = spectrogram.abs().pow(2.0)
        mel = self.mel_filters.matmul(power_spec).transpose(0, 1)
        logmel = mel.to(self.torch.float32)
        logmel = logmel.clamp_(min=1e-10).log10_()
        mx = logmel.amax(dim=(-2, -1), keepdim=True)
        logmel = self.torch.maximum(logmel, mx - 8.0).div_(4).add_(1)
        if logmel.shape[0] % 2 == 1:
            logmel = logmel[:-1]
        return logmel.reshape(-1, 2 * logmel.shape[-1])

    def _build_mel_filters(self) -> Any:
        n_freqs = self.n_fft // 2 + 1
        all_freqs = self.torch.linspace(0, self.sampling_rate / 2, n_freqs)
        m_min = self._hz_to_mel(self.torch.tensor(0.0))
        m_max = self._hz_to_mel(self.torch.tensor(self.sampling_rate / 2))
        m_pts = self.torch.linspace(m_min, m_max, self.n_mels + 2)
        f_pts = self._mel_to_hz(m_pts)

        filters = self.torch.zeros(self.n_mels, n_freqs)
        for i in range(self.n_mels):
            lower = f_pts[i]
            center = f_pts[i + 1]
            upper = f_pts[i + 2]
            left = (all_freqs - lower) / (center - lower)
            right = (upper - all_freqs) / (upper - center)
            filters[i] = self.torch.maximum(self.torch.zeros_like(left), self.torch.minimum(left, right))
        return filters

    def _hz_to_mel(self, hz: Any) -> Any:
        return 2595.0 * self.torch.log10(1.0 + hz / 700.0)

    def _mel_to_hz(self, mel: Any) -> Any:
        return 700.0 * (self.torch.pow(10.0, mel / 2595.0) - 1.0)

    def _get_num_audio_features(self, audio_lengths: list[int]) -> list[int]:
        import math

        effective_window_size = self.projector_window_size // self.projector_downsample_rate
        projector_lengths = []
        for raw_length in audio_lengths:
            mel_length = raw_length // self.hop_length + 1
            encoder_length = mel_length // 2
            nblocks = math.ceil(encoder_length / self.projector_window_size)
            projector_lengths.append(nblocks * effective_window_size)
        return projector_lengths


def disable_broken_torchvision() -> None:
    try:
        import importlib.util

        torchvision_spec = importlib.util.find_spec("torchvision")
        torchvision_io_spec = importlib.util.find_spec("torchvision.io")
        if torchvision_spec is None or torchvision_io_spec is not None:
            return

        import transformers.utils as hf_utils
        import transformers.utils.import_utils as hf_import_utils

        hf_utils.is_torchvision_available = lambda: False
        hf_utils.is_torchvision_v2_available = lambda: False
        hf_import_utils.is_torchvision_available = lambda: False
        hf_import_utils.is_torchvision_v2_available = lambda: False
        print(
            "Detected incomplete torchvision install; disabling torchvision "
            "inside transformers for Granite speech loading."
        )
    except Exception:
        pass


def resolve_device(torch_module: Any) -> str:
    if DEVICE.lower() != "auto":
        return DEVICE
    return "cuda" if torch_module.cuda.is_available() else "cpu"


def resolve_dtype(torch_module: Any, device: str) -> Any:
    dtype = TORCH_DTYPE.lower()
    if dtype == "auto":
        return torch_module.bfloat16 if device.startswith("cuda") else torch_module.float32
    dtype_map = {
        "float32": torch_module.float32,
        "fp32": torch_module.float32,
        "float16": torch_module.float16,
        "fp16": torch_module.float16,
        "bfloat16": torch_module.bfloat16,
        "bf16": torch_module.bfloat16,
    }
    if dtype not in dtype_map:
        raise RuntimeError(
            "Invalid GRANITE_ASR_TORCH_DTYPE. Use auto, float32, float16, or bfloat16."
        )
    return dtype_map[dtype]


def load_model() -> dict[str, Any]:
    if "model_bundle" in app_state:
        return app_state["model_bundle"]

    with model_lock:
        if "model_bundle" in app_state:
            return app_state["model_bundle"]

        try:
            import torch
            import scipy.signal
            import soundfile as sf
            disable_broken_torchvision()
            from transformers.models.granite_speech.modeling_granite_speech import (
                GraniteSpeechForConditionalGeneration,
            )
            from transformers.models.granite_speech.processing_granite_speech import (
                GraniteSpeechProcessor,
            )
            from transformers.models.auto.tokenization_auto import AutoTokenizer
            from transformers.utils import logging as hf_logging
        except ModuleNotFoundError as exc:
            missing = exc.name or "a required package"
            raise RuntimeError(
                f"{missing} is not installed in this Python environment. "
                "Install the Granite ASR dependencies and restart: "
                "transformers>=4.52.1 soundfile scipy accelerate"
            ) from exc

        hf_logging.set_verbosity_error()

        device = resolve_device(torch)
        torch_dtype = resolve_dtype(torch, device)

        print(f"Loading Granite ASR model: {MODEL_ID}")
        print(f"Device: {device}")
        print(f"Torch dtype: {torch_dtype}")
        start = time.perf_counter()

        tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
        audio_processor = TorchGraniteSpeechFeatureExtractor(
            torch_module=torch,
            sampling_rate=TARGET_SAMPLE_RATE,
        )
        processor = GraniteSpeechProcessor(
            audio_processor=audio_processor,
            tokenizer=tokenizer,
            chat_template=getattr(tokenizer, "chat_template", None),
        )
        tokenizer = processor.tokenizer
        model = GraniteSpeechForConditionalGeneration.from_pretrained(
            MODEL_ID,
            device_map=device,
            torch_dtype=torch_dtype,
        )
        model.eval()

        generation_config = getattr(model, "generation_config", None)
        if generation_config is not None:
            generation_config.temperature = None
            if generation_config.pad_token_id is None:
                generation_config.pad_token_id = generation_config.eos_token_id

        bundle = {
            "model": model,
            "processor": processor,
            "tokenizer": tokenizer,
            "torch": torch,
            "scipy_signal": scipy.signal,
            "soundfile": sf,
            "device": device,
            "torch_dtype": str(torch_dtype).replace("torch.", ""),
        }
        app_state["model_bundle"] = bundle
        print(f"Granite ASR model ready in {time.perf_counter() - start:.2f} seconds")
        return bundle


def load_audio(audio_path: str, bundle: dict[str, Any]) -> Any:
    import math

    scipy_signal = bundle["scipy_signal"]
    sf = bundle["soundfile"]
    wav, sr = sf.read(audio_path, dtype="float32", always_2d=False)
    if getattr(wav, "ndim", 1) > 1:
        wav = wav.mean(axis=1)
    if sr != TARGET_SAMPLE_RATE:
        gcd = math.gcd(sr, TARGET_SAMPLE_RATE)
        wav = scipy_signal.resample_poly(wav, TARGET_SAMPLE_RATE // gcd, sr // gcd).astype(
            "float32",
            copy=False,
        )
    return wav.astype("float32", copy=False)


def transcribe_path(audio_path: str) -> str:
    bundle = load_model()
    model = bundle["model"]
    processor = bundle["processor"]
    tokenizer = bundle["tokenizer"]
    torch_module = bundle["torch"]
    device = bundle["device"]

    wav = load_audio(audio_path, bundle)
    chat = [{"role": "user", "content": PROMPT}]
    prompt = tokenizer.apply_chat_template(chat, tokenize=False, add_generation_prompt=True)
    model_inputs = processor(prompt, wav, device=device, return_tensors="pt").to(device)

    with torch_module.inference_mode():
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
    )
    return output_text[0].strip()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    app_state.clear()


app = FastAPI(title="Granite ASR Demo", lifespan=lifespan)

GRANITE_INDEX_HTML = INDEX_HTML.replace("Qwen3 ASR", "Granite 4.0 1B Speech").replace(
    "local Qwen ASR model",
    "local IBM Granite Speech model",
)


@app.get("/")
async def index() -> HTMLResponse:
    return HTMLResponse(content=GRANITE_INDEX_HTML)


@app.get("/favicon.ico")
async def favicon() -> Response:
    return Response(status_code=204)


@app.get("/health")
async def health() -> dict[str, Any]:
    bundle = app_state.get("model_bundle", {})
    return {
        "ok": True,
        "model_loaded": "model_bundle" in app_state,
        "model_id": MODEL_ID,
        "device": bundle.get("device", DEVICE),
        "torch_dtype": bundle.get("torch_dtype", TORCH_DTYPE),
        "max_new_tokens": MAX_NEW_TOKENS,
        "target_sample_rate": TARGET_SAMPLE_RATE,
    }


def run_transcription_job(job_id: str, tmp_path: str) -> None:
    started = time.perf_counter()
    started_at = datetime.now()

    with job_lock:
        app_state["jobs"][job_id].update(
            {
                "status": "running",
                "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
            }
        )

    try:
        text = transcribe_path(tmp_path)
        elapsed = time.perf_counter() - started
        ended_at = datetime.now()
        bundle = app_state.get("model_bundle", {})
        result = {
            "status": "completed",
            "text": text,
            "processing_time_seconds": round(elapsed, 2),
            "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": ended_at.strftime("%Y-%m-%d %H:%M:%S"),
            "model": MODEL_ID,
            "device": bundle.get("device", DEVICE),
            "torch_dtype": bundle.get("torch_dtype", TORCH_DTYPE),
        }
    except Exception as exc:
        traceback.print_exc()
        result = {
            "status": "failed",
            "detail": str(exc),
            "started_at": started_at.strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    with job_lock:
        app_state["jobs"][job_id].update(result)


@app.get("/transcribe/{job_id}")
async def transcription_job(job_id: str) -> JSONResponse:
    job = app_state.setdefault("jobs", {}).get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Transcription job was not found.")
    return JSONResponse(job)


@app.post("/transcribe")
async def transcribe_audio(background_tasks: BackgroundTasks, file: UploadFile = File(...)) -> JSONResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="No audio file was uploaded.")

    suffix = Path(file.filename).suffix or ".wav"
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    job_id = uuid.uuid4().hex
    queued_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    app_state.setdefault("jobs", {})[job_id] = {
        "job_id": job_id,
        "status": "queued",
        "queued_at": queued_at,
        "model": MODEL_ID,
    }
    background_tasks.add_task(run_transcription_job, job_id, tmp_path)
    bundle = app_state.get("model_bundle", {})
    return JSONResponse(
        {
            "job_id": job_id,
            "status": "queued",
            "queued_at": queued_at,
            "model": MODEL_ID,
            "device": bundle.get("device", DEVICE),
            "torch_dtype": bundle.get("torch_dtype", TORCH_DTYPE),
        },
        status_code=202,
    )


if __name__ == "__main__":
    uvicorn.run("granite_asr:app", host=HOST, port=PORT, reload=False)
