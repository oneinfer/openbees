# Bees

**Mission Control for Hermes Agent**

Hermes Agent is powerful, but running real work on it means juggling terminal sessions, losing track of which job finished, and manually checking on long-running tasks. The more you delegate, the harder it gets to manage.

Bees gives you one screen to create, supervise, and review autonomous Hermes Agent work.


## Preview

Bees task dashboard

## Demo



## Why Bees Exists

The first agent task is fun. The tenth is operations.

Power users do not just ask an agent one question. They delegate research, coding, monitoring, sales ops, writing, and recurring workflows. Those jobs take time. They need review. Cron runs disappear into the background. Context fills up.

Bees turns Hermes sessions into durable, reviewable work.

## Not Just A Board

Bees is not just a task board. After each agent turn, a lightweight completion judge evaluates whether the task is done and auto-moves it to **Ready for review**. You verify and close — nothing moves to done without your sign-off.

## Features

- **Kanban board**: see every task at a glance: in progress, in review, done
- **Autonomous execution**: describe what you want in chat, walk away; the agent decides how to get it done
- **Completion judge**: after each agent turn, a lightweight LLM call evaluates whether the task is done
- **Live streaming**: watch tool calls, reasoning, and responses in real time
- **Human-in-the-loop**: agents propose completion; you verify and close. Nothing moves to done without your sign-off
- **Per-task model control**: override model and reasoning effort on any task
- **Cron visibility**: see every scheduled Hermes job, its history, and output
- **File browser**: see files agents have created in the workspace directory
- **Local-first option**: self-host with SQLite, no account, and no cloud dependency. Your local data stays on your machine

## Quick Start

**Prerequisites:** Node.js 20-23 (Node.js 22 LTS recommended). `npm install` and `npm run dev` will detect Hermes Agent, write the discovered `HERMES_AGENT_DIR`, `HERMES_PYTHON`, and `HERMES_HOME` values to local `.env`, and run the official Hermes installer if Hermes is missing. `npm install` also prepares the local activity daemon dependencies best-effort, and `npm run dev` starts the daemon with OpenBees.

```bash
git clone https://github.com/oneinfer/openbees.git
cd openbees
npm install
npm run dev
```

Open [http://localhost:6969](http://localhost:6969).

For production, run `npm run prod`.

If you hit a `better-sqlite3` install failure on Windows with Node 24, switch to Node 22 LTS and retry. This repo now expects Node `>=20 <24`.

Hermes setup can also be run directly:

```bash
npm run setup:hermes
```

By default the setup scans `PATH`, configured env vars, and common Hermes install locations. For a slower broader scan, run with `Bees_HERMES_FULL_SCAN=1`.

Optional microphone transcription uses Qwen3-ASR. `npm run dev` prepares the local ASR environment automatically if needed. There is no separate ASR service to start; the backend launches the ASR worker on demand when the microphone transcription endpoint is used.

The desktop activity daemon is managed by OpenBees in development. It captures local context only, binds to `127.0.0.1`, and stores data under `~/.bees/activity-daemon` by default. Useful overrides:

```bash
BEES_ACTIVITY_ENABLED=false
BEES_SKIP_ACTIVITY_DAEMON_INSTALL=1
BEES_ACTIVITY_HOST=127.0.0.1
BEES_ACTIVITY_PORT=4768
BEES_ACTIVITY_PYTHON=/path/to/python
BEES_ACTIVITY_DATA_DIR=~/.bees/activity-daemon
BEES_ACTIVITY_REQUIRE_INPUT_DEVICE=true
```

You can also prepare or repair its Python dependencies directly:

```bash
npm run setup:activity
```

## How It Works

```
Browser (React + Vite)
  ↕ HTTP + SSE
Express server (:6969)
  ↕ JSONL stdin/stdout
Python worker → Hermes AIAgent
  +
Managed local activity daemon (:4768)
```

Each task is a persistent Hermes root session. You talk to it, it works, and the board reflects where everything stands. Chat transcripts live in Hermes's session database; Bees stores task metadata, status, and per-task settings in a local SQLite database.

## Who It's For

- **Hermes power users** juggling multiple sessions across projects
- **Indie founders** delegating research, ops, writing, and coding to their agent
- **Anyone running long-lived Hermes work** who needs to know what finished, what's stuck, and what needs attention

## Roadmap

- **Cron supervision**: automatically monitor, recover, and report on scheduled agent jobs
- **Notifications**: get alerted via Telegram, WhatsApp, or webhook when a task needs review
- **Skills library**: pluggable skill templates for common workflows (lead gen, web research, content pipelines, data collection, competitive monitoring, outbound sequences)
- **OpenClaw adapter**: run Bees against OpenClaw-hosted agents

## FAQ

**Can I use this with other agents?**
Not yet. The adapter interface exists, but launch is Hermes-only. OpenClaw is next.

## Contributing

Contributions are welcome. Please open an issue first with the feature or change you have in mind and why it should be added. Once the approach is approved, create a PR. See [CLAUDE.md](CLAUDE.md) for architecture and development details.
