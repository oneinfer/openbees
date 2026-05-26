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

Data is local-only by default and is written under:

```text
~/.oneinfer/activity-daemon/
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

The primary trigger is the current wake-word flow: say "hey bees", speak the input, then drag-select text. A manual capture can also be requested with `POST /capture`.
