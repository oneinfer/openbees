# Runtime Setup

This app supports four task runtimes:

- `hermes`
- `codex`
- `claude_code`
- `opencode`

## What works today

### Hermes

Hermes is the only runtime with built-in model discovery in the UI right now.

- The app can list Hermes models
- The app can set Hermes reasoning effort
- The app can show Hermes defaults in Settings

### Codex, Claude Code, OpenCode

These are currently command-backed runtimes.

That means:

- the app runs a configured command inside the approved repo
- the command decides which model to use
- the app does not yet fetch model lists for these runtimes
- the app does not yet show a model picker for these runtimes

## Required environment variables

Configure `.env` with the runtime(s) you want to use:

```env
BEES_DEFAULT_RUNTIME=hermes

BEES_CODEX_COMMAND=codex
BEES_CLAUDE_CODE_COMMAND=claude
BEES_OPENCODE_COMMAND=opencode
```

These can also point to wrapper scripts if you want a fixed model or extra flags.

## Built-in defaults

If you use the plain CLI names above, the app now adds the safe non-interactive defaults for you:

- `codex` runs as `codex exec ... -`
- `claude` runs as `claude -p --output-format text ...`
- `opencode` runs as `opencode run ...`

The app also:

- passes the full task prompt on stdin
- strips terminal ANSI noise from output
- gives OpenCode an isolated writable config directory so it can run cleanly inside the app

## Model selection

Hermes still uses the built-in model catalog.

For `codex`, `claude_code`, and `opencode`:

- you can type a model id directly in the task toolbar
- that model id is passed through to the CLI when supported
- Hermes model lists are no longer shown for those runtimes

## If you leave the variables empty

The app will fall back to the plain executable names shown above. If the CLI is not installed or not on `PATH`, the task run will fail when launched.

## Old configuration error

Older builds treated empty runtime commands as unconfigured and failed with:

```text
[Error: <runtime> runtime is not configured. Set the corresponding BEES_*_COMMAND environment variable.]
```

## Context passed to command runtimes

When the app runs a command runtime, it provides task context through environment variables:

- `BEES_RUNTIME`
- `BEES_TASK_ID`
- `BEES_TASK_TITLE`
- `BEES_TASK_REPO`
- `BEES_TASK_MESSAGE`
- `BEES_TASK_SYSTEM_PROMPT`
- `BEES_TASK_PROMPT_FILE`
- `BEES_TASK_CONTEXT_FILE`

`BEES_TASK_CONTEXT_FILE` contains a JSON payload with:

- runtime
- sessionId
- message
- systemMessage
- task metadata
- settings

## Recommended wrapper pattern

Use a wrapper script per runtime. The wrapper can:

- validate the CLI is installed
- choose a fixed model
- map environment variables into the CLI's prompt/input format
- add auth or provider flags

Example idea:

- `run-codex.cmd` could always run your preferred Codex model
- `run-claude-code.cmd` could always run your preferred Claude Code model
- `run-opencode.cmd` could always run your preferred OpenCode model

## Important limitation

For `codex`, `claude_code`, and `opencode`, model selection is currently owned by the wrapper command, not by the app UI.

If you want the app itself to:

- list models for each runtime
- let users pick a model per task
- store per-runtime model defaults

that needs one more implementation pass in the backend and UI.
