# OneInfer Activity Daemon

Standalone local desktop activity collector.

Run:

```bash
python -m activity_daemon.daemon --host 127.0.0.1 --port 4768
```

Install dependencies:

```bash
python -m pip install -r activity_daemon/requirements.txt
```

On Windows, use the same Python interpreter for install and run. For example:

```powershell
C:\Users\Administrator\AppData\Local\Programs\Python\Python310\python.exe -m pip install -r activity_daemon\requirements.txt
C:\Users\Administrator\AppData\Local\Programs\Python\Python310\python.exe -m activity_daemon.daemon --host 127.0.0.1 --port 4768
```

When speech is enabled, the Qwen ASR model is preloaded before the HTTP server starts so the first wake phrase does not pay the model-load delay. To disable preload for faster startup:

```powershell
$env:PRELOAD_ASR_MODEL="0"
```

The wake phrase is detected with the bundled openWakeWord ONNX model:

```text
activity_daemon/models/hey_bee.onnx
```

You can tune or override it with:

```powershell
$env:WAKEWORD_ENGINE_ENABLED="1"
$env:WAKEWORD_MODEL_PATH="C:\path\to\hey_bee.onnx"
$env:WAKEWORD_THRESHOLD="0.5"
$env:WAKEWORD_ASR_FALLBACK_ENABLED="1"
```

When `WAKEWORD_ASR_FALLBACK_ENABLED` is on, the daemon still tries the bundled
openWakeWord model first, then falls back to Qwen ASR phrase matching if the
model rejects a voice clip. This helps during early model tuning and for voices
that were not represented well in the synthetic training set.

The daemon auto-selects ASR runtime settings:

- CUDA available: `cuda:0` with `bfloat16`
- No CUDA: `cpu` with `float32`

You can force these settings:

```powershell
$env:STT_DEVICE_MAP="cpu"
$env:STT_DTYPE="float32"
```

Speech clips are screened with Silero VAD before they are sent to `Qwen/Qwen3-ASR-0.6B`. VAD is required: if Silero is unavailable or rejects the clip, the daemon will not run ASR for that audio. The VAD thresholds can be tuned:

```powershell
$env:VAD_THRESHOLD="0.5"
$env:VAD_MIN_SPEECH_DURATION_MS="120"
$env:VAD_MIN_SILENCE_DURATION_MS="80"
$env:VAD_SPEECH_PAD_MS="30"
```

Data is local-only by default and is written under:

```text
~/.oneinfer/activity-daemon/
```

Every capture also writes a timestamped artifact folder:

```text
~/.oneinfer/activity-daemon/captures/YYYYMMDDTHHMMSSffffffZ_<event-id>/
  event.json
  images/
    cursor_*.png
    selected_text_*.png
```

`event.json` contains the timestamp, copied/selected text, active window metadata, mouse drag coordinates, and paths to any saved screenshots.

By default, drag selection leaves the copied selection text on the system clipboard. To restore the previous clipboard after capture, set:

```json
{
  "preserve_clipboard_after_selection_copy": true
}
```

Useful endpoints:

- `GET /health`
- `GET /config`
- `PUT /config`
- `POST /arm`
- `POST /speech/suppress`
- `POST /speech/release`
- `POST /capture`
- `GET /events/latest`
- `GET /events?limit=50`
- `GET /events/stream`

The primary trigger is the current wake-word flow: say "hey bee", speak the input, then drag-select text. The spoken input is transcribed and included with the task text; if no drag selection is made, the daemon captures a screenshot and uses the spoken input as the task request. A manual capture can also be requested with `POST /capture`.

By default, after the wake phrase the daemon listens for a spoken command and stays armed for drag selection. To skip the follow-up command and arm immediately, set:

```powershell
$env:LISTEN_FOR_COMMAND_AFTER_WAKE="0"
```

Wake matching defaults to relaxed mode so common ASR variants like `h b` and `e b` still arm the daemon. To require clearer wake phrases:

```powershell
$env:WAKE_MATCH_MODE="strict"
```

Quick API test:

```powershell
Invoke-RestMethod http://127.0.0.1:4768/health
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4768/arm -ContentType "application/json" -Body '{"spoken_input":"test selection"}'
```

After `/arm`, drag-select text in another app. The daemon should automatically create a `voice_selection` event. Check it with:

```powershell
Invoke-RestMethod http://127.0.0.1:4768/events/latest
```

If drag selection is not captured, inspect:

```powershell
Invoke-RestMethod http://127.0.0.1:4768/health
```

Important fields:

- `armed`: whether the daemon is currently waiting for a drag
- `last_selection_status`: whether the last drag was accepted or ignored
- `collectors.speech.last_wake_text`: what ASR heard
- `collectors.speech.last_status`: current wake/selection state

Manual capture test:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4768/capture -ContentType "application/json" -Body '{"trigger":"manual","include_base64":false}'
```
