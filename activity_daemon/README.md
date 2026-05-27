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

The daemon auto-selects ASR runtime settings:

- CUDA available: `cuda:0` with `bfloat16`
- No CUDA: `cpu` with `float32`

You can force these settings:

```powershell
$env:STT_DEVICE_MAP="cpu"
$env:STT_DTYPE="float32"
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
- `POST /capture`
- `GET /events/latest`
- `GET /events?limit=50`
- `GET /events/stream`

The primary trigger is the current wake-word flow: say "hey bee", speak the input, then drag-select text. A manual capture can also be requested with `POST /capture`.

By default, after the wake phrase the daemon arms immediately for drag selection. If you want it to listen for a spoken command after "hey bee", set:

```powershell
$env:LISTEN_FOR_COMMAND_AFTER_WAKE="1"
```

Wake matching defaults to relaxed mode so common ASR variants like `a b`, `h b`, and `e b` still arm the daemon. To require clearer wake phrases:

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
