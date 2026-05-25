# Qwen3 ASR Voice Input Integration Plan

This document describes the requirements and implementation plan for adding speech input to Bees with `Qwen/Qwen3-ASR-0.6B`.

## Goal

Add a microphone button to the task composer so users can speak a task or chat message. The app records a short audio clip, sends it to the backend, transcribes it with Qwen3-ASR, inserts the transcript into the existing text input, and lets the user review or edit before sending.

Qwen3-ASR should be treated as speech-to-text only. Hermes and the existing task runtimes remain responsible for executing the task after the final text message is submitted.

## Model Capability Summary

`Qwen/Qwen3-ASR-0.6B` is an automatic speech recognition model. The Qwen model card says the Qwen3-ASR family supports offline and streaming inference, accepts local paths, URLs, base64 audio, and array inputs through the `qwen-asr` Python package, and returns transcript text plus detected language. Streaming support currently belongs to the vLLM backend, so the first Bees integration should use offline clip transcription.

Reference: https://huggingface.co/Qwen/Qwen3-ASR-0.6B

## Requirements

### Runtime Requirements

- Node.js `>=20 <24`, same as the existing app.
- Python 3.12 is recommended for the Qwen ASR environment.
- A separate Python virtual environment for Qwen ASR.
- `qwen-asr` installed in that environment.
- PyTorch installed with the correct CPU or CUDA build for the machine.
- Model weights for `Qwen/Qwen3-ASR-0.6B`, downloaded automatically by Hugging Face or pre-downloaded to a local model directory.
- Optional but recommended: `ffmpeg`, for converting browser-recorded audio into a predictable WAV format.

### Hardware Requirements

- GPU with CUDA is strongly recommended for good latency.
- CPU can be supported as a fallback, but transcription may be slow.
- Enough disk space for model weights and cache.
- Enough memory for Qwen ASR model load plus the existing Bees/Hermes process.

The first implementation should load one ASR model instance and limit concurrent ASR jobs to one by default. This avoids out-of-memory errors and keeps behavior predictable.

### Browser Requirements

- Browser support for `navigator.mediaDevices.getUserMedia`.
- Browser support for `MediaRecorder`.
- Microphone permission granted by the user.
- HTTPS is required for remote deployments because browsers restrict microphone access on insecure origins. `localhost` works during local development.

### Environment Variables

Add these optional variables:

```env
QWEN_ASR_ENABLED=false
QWEN_ASR_PYTHON=
QWEN_ASR_MODEL=Qwen/Qwen3-ASR-0.6B
QWEN_ASR_DEVICE=cuda:0
QWEN_ASR_DTYPE=bfloat16
QWEN_ASR_LANGUAGE=
QWEN_ASR_MAX_AUDIO_MB=25
QWEN_ASR_RUN_LIMIT=1
QWEN_ASR_REQUIRE_FFMPEG=false
```

Suggested behavior:

- If `QWEN_ASR_ENABLED` is not `true`, hide or disable voice input.
- If `QWEN_ASR_PYTHON` is empty, try a documented default path under `BEES_HOME`, then fall back to `python`.
- If `QWEN_ASR_LANGUAGE` is empty, let Qwen auto-detect the language.
- If `QWEN_ASR_REQUIRE_FFMPEG=true`, fail health checks when `ffmpeg` is unavailable.

## Architecture

```text
Browser
  -> MediaRecorder captures audio
  -> POST /api/asr/transcribe multipart upload
Express
  -> saves audio to temp file
  -> optionally converts to WAV with ffmpeg
  -> sends JSONL request to Qwen ASR worker
Python Qwen ASR worker
  -> lazily loads Qwen3ASRModel
  -> transcribes audio path
  -> returns text and language
Express
  -> returns transcript JSON
Browser
  -> inserts transcript into textarea
```

## Backend Implementation

### New Files

- `server/routes/asr.ts`
- `server/asr/qwen-worker.ts`
- `server/workers/qwen_asr_worker.py`

### Route

Add:

```text
POST /api/asr/transcribe
```

Request:

- `multipart/form-data`
- field `audio`: recorded audio blob
- optional field `language`: language override

Response:

```json
{
  "text": "Create a task to inspect the failing build",
  "language": "English",
  "durationMs": 1430
}
```

Errors:

- `400`: missing audio
- `413`: audio too large
- `503`: ASR disabled or worker unavailable
- `500`: transcription failed

### Worker Protocol

Use JSONL like the Hermes worker.

Request:

```json
{
  "id": "request-id",
  "type": "transcribe",
  "audioPath": "/tmp/bees-audio.webm",
  "language": null
}
```

Result:

```json
{
  "id": "request-id",
  "ok": true,
  "text": "Create a task to inspect the failing build",
  "language": "English"
}
```

Health request:

```json
{
  "id": "request-id",
  "type": "health"
}
```

The worker should lazy-load the model on first transcription, not during app startup. That keeps Bees usable even if ASR has not been used yet.

### Python Worker Sketch

```python
from qwen_asr import Qwen3ASRModel
import torch

model = None

def get_model():
    global model
    if model is None:
        model = Qwen3ASRModel.from_pretrained(
            MODEL_NAME,
            dtype=getattr(torch, DTYPE),
            device_map=DEVICE,
            max_inference_batch_size=1,
            max_new_tokens=512,
        )
    return model

def transcribe(audio_path, language):
    results = get_model().transcribe(audio=audio_path, language=language)
    first = results[0]
    return {"text": first.text, "language": first.language}
```

## Frontend Implementation

### New Files

- `client/src/hooks/useVoiceRecorder.ts`
- `client/src/components/VoiceInputButton.tsx`

### Existing Files To Update

- `client/src/components/TaskChat.tsx`
- `client/src/components/NewTaskPage.tsx`
- `client/src/lib/api.ts`

### UI Behavior

- Add a microphone icon button next to attachments and input toolbar.
- First click starts recording.
- While recording, show a stop control and recording state.
- Stop sends audio to `/api/asr/transcribe`.
- When transcription returns, append or insert the text into the textarea.
- Do not auto-send the message.
- Disable recording while a task run is streaming.
- Show a compact error message if microphone permission or transcription fails.

### API Helper

Add a helper in `client/src/lib/api.ts`:

```ts
export async function transcribeAudio(audio: Blob, language?: string): Promise<{
  text: string;
  language?: string;
  durationMs?: number;
}> {
  const form = new FormData();
  form.append('audio', audio, 'speech.webm');
  if (language) form.append('language', language);
  return request('/asr/transcribe', { method: 'POST', body: form });
}
```

The existing `request` helper may need to avoid forcing JSON headers when the body is `FormData`.

## Audio Format Strategy

Start by uploading the browser blob directly. Common browser MIME types include:

- `audio/webm`
- `audio/webm;codecs=opus`
- `audio/ogg;codecs=opus`

If Qwen ASR or the installed audio backend fails to decode the browser format, add an ffmpeg conversion step:

```text
input.webm -> 16 kHz mono wav -> Qwen ASR
```

The backend should delete temporary uploaded and converted files after transcription.

## Security And Limits

- Limit audio upload size with multer.
- Store temporary audio under `BEES_HOME/tmp/asr` or OS temp directory.
- Delete temp files after request completion.
- Do not expose arbitrary file paths from the client.
- Do not let `/api/asr/transcribe` read files outside server-created temp paths.
- Keep the ASR worker concurrency at `1` initially.
- Add route-level timeout protection.

## Setup Notes

Example Linux/macOS setup:

```bash
python3.12 -m venv ~/.bees/qwen-asr-venv
~/.bees/qwen-asr-venv/bin/pip install -U qwen-asr
```

Development startup stays simple: `npm run dev` creates `.venv-qwen-asr`, installs `qwen-asr` if it is missing, writes the required `QWEN_ASR_*` values into local `.env`, and starts the app. `npm run setup:asr` is available as a repair/prep command, but normal users do not need it. The backend starts the ASR worker on demand.

Example Windows manual setup if you want to prepare it yourself:

```powershell
python -m venv .venv-qwen-asr
.\.venv-qwen-asr\Scripts\pip.exe install -U qwen-asr
```

Then set local `.env` values. Keep committed examples path-free:

```env
QWEN_ASR_ENABLED=true
QWEN_ASR_PYTHON=
QWEN_ASR_MODEL=Qwen/Qwen3-ASR-0.6B
QWEN_ASR_DEVICE=cuda:0
QWEN_ASR_DTYPE=bfloat16
```

For CPU fallback:

```env
QWEN_ASR_DEVICE=cpu
QWEN_ASR_DTYPE=float32
```

## Implementation Milestones

1. Add the backend ASR route with upload limits and disabled-state handling.
2. Add the Qwen ASR worker adapter and JSONL Python worker.
3. Add ASR health information to `/api/health`.
4. Add `transcribeAudio()` to the client API helper.
5. Add `useVoiceRecorder()` and `VoiceInputButton`.
6. Wire voice input into `TaskChat`.
7. Wire voice input into `NewTaskPage`.
8. Add docs to `README.md` or `docs/runtime-setup.md`.
9. Test local recording, upload, transcription, textarea insertion, and normal send flow.
10. Consider vLLM streaming transcription as a later enhancement.

## Validation Checklist

- App still starts with ASR disabled.
- `/api/health` reports ASR disabled or unavailable clearly.
- Recording button is hidden or disabled if ASR is unavailable.
- User can record, stop, transcribe, edit, and send in `TaskChat`.
- User can record, stop, transcribe, edit, and create a task in `NewTaskPage`.
- Transcription failure does not erase typed text.
- Temporary audio files are cleaned up.
- Production build includes `server/workers/qwen_asr_worker.py`.
