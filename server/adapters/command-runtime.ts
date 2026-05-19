import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentModelsResponse, AgentModelOption, AgentRuntime, SessionMetadata, TaskMessage } from '../../shared/types.js';
import type { AgentAdapter, AgentRunOptions, StreamEvent } from './types.js';
import { resolveMinionsWorkspaceDir } from '../paths.js';

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  }[] = [];
  let ended = false;
  let failure: Error | null = null;

  return {
    push(value: T) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ value, done: false });
      else values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length > 0) waiters.shift()?.resolve({ value: undefined as T, done: true });
    },
    fail(error: Error) {
      failure = error;
      while (waiters.length > 0) waiters.shift()?.reject(error);
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length > 0) return Promise.resolve({ value: values.shift() as T, done: false });
          if (failure) return Promise.reject(failure);
          if (ended) return Promise.resolve({ value: undefined as T, done: true });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
      };
    },
  };
}

async function writeTaskFiles(runtime: AgentRuntime, sessionId: string, message: string, options?: AgentRunOptions) {
  const dir = join(tmpdir(), 'minions-runtime-prompts', runtime, sessionId);
  await mkdir(dir, { recursive: true });

  const promptFile = join(dir, 'prompt.txt');
  const contextFile = join(dir, 'task-context.json');
  const payload = {
    runtime,
    sessionId,
    message,
    systemMessage: options?.systemMessage ?? null,
    task: {
      id: options?.task?.id ?? sessionId,
      title: options?.task?.title ?? null,
      workspacePath: options?.task?.workspacePath ?? null,
    },
    settings: options?.settings ?? {},
  };

  await writeFile(promptFile, `${options?.systemMessage ? `${options.systemMessage}\n\n` : ''}${message}`, 'utf8');
  await writeFile(contextFile, JSON.stringify(payload, null, 2), 'utf8');
  return { dir, promptFile, contextFile };
}

function parseCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }

      if (char === '\\' && quote === '"' && command[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }

      current += char;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\u0007|\x1B\\))/g, '');
}

function executableStem(executable: string): string {
  return basename(executable).toLowerCase().replace(/\.(cmd|bat|exe|ps1)$/i, '');
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function pathEnvValue(): string {
  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path');
  return entry?.[1] ?? '';
}

function pathextValues(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1';
  return raw.split(';').map((item) => item.trim()).filter(Boolean);
}

function resolveWindowsExecutable(command: string): string {
  const candidates: string[] = [];
  const hasExtension = /\.[^./\\]+$/.test(command);
  const extensions = hasExtension ? [''] : pathextValues();

  if (command.includes('/') || command.includes('\\')) {
    const base = isAbsolute(command) ? command : resolve(process.cwd(), command);
    for (const extension of extensions) {
      candidates.push(`${base}${extension}`);
    }
  } else {
    const dirs = pathEnvValue().split(';').map((entry) => entry.trim()).filter(Boolean);
    for (const dir of dirs) {
      for (const extension of extensions) {
        candidates.push(join(dir, `${command}${extension}`));
      }
    }
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? command;
}

function resolveExecutable(command: string): string {
  if (process.platform === 'win32') return resolveWindowsExecutable(command);
  if (command.includes('/') || command.includes('\\')) return isAbsolute(command) ? command : resolve(process.cwd(), command);
  return command;
}

// Map app ReasoningEffort values to Codex model_reasoning_effort config values.
function toCodexReasoningEffort(effort: string): string | null {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'high-v2';
    default: return null;
  }
}

function applyCodexDefaults(args: string[], options?: AgentRunOptions): string[] {
  const normalized = args[0] === 'exec' ? args.slice(1) : args.slice();
  const next: string[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const arg = normalized[index];
    if (arg === '--ask-for-approval') {
      if (normalized[index + 1] && !normalized[index + 1].startsWith('-')) index += 1;
      continue;
    }
    next.push(arg);
  }

  if (!hasFlag(next, '-m', '--model') && options?.settings?.model) {
    next.push('-m', options.settings.model);
  }
  // Pass reasoning effort via -c config override if not already set.
  const effortValue = options?.settings?.reasoningEffort
    ? toCodexReasoningEffort(options.settings.reasoningEffort)
    : null;
  if (effortValue && !next.some((arg) => arg.startsWith('model_reasoning_effort'))) {
    next.push('-c', `model_reasoning_effort="${effortValue}"`);
  }
  if (!hasFlag(next, '-s', '--sandbox') && !hasFlag(next, '--dangerously-bypass-approvals-and-sandbox')) {
    next.push('--sandbox', 'workspace-write');
  }
  if (!hasFlag(next, '--skip-git-repo-check')) next.push('--skip-git-repo-check');
  if (!next.includes('-')) next.push('-');

  return ['exec', ...next];
}

function applyClaudeDefaults(args: string[], options?: AgentRunOptions): string[] {
  const next = args.slice();
  if (!hasFlag(next, '-p', '--print')) next.push('-p');
  if (!hasFlag(next, '--output-format')) next.push('--output-format', 'text');
  if (!hasFlag(next, '--dangerously-skip-permissions', '--permission-mode')) {
    next.push('--dangerously-skip-permissions');
  }
  if (!hasFlag(next, '--model') && options?.settings?.model) {
    next.push('--model', options.settings.model);
  }
  if (!hasFlag(next, '--effort') && options?.settings?.reasoningEffort) {
    next.push('--effort', options.settings.reasoningEffort);
  }
  return next;
}

function applyOpenCodeDefaults(args: string[], options?: AgentRunOptions): string[] {
  const normalized = args[0] === 'run' ? args.slice(1) : args.slice();
  const next = ['run', ...normalized];
  if (!hasFlag(next, '--pure')) next.push('--pure');
  if (!hasFlag(next, '--format')) next.push('--format', 'default');
  if (!hasFlag(next, '--dangerously-skip-permissions')) {
    next.push('--dangerously-skip-permissions');
  }
  if (!hasFlag(next, '-m', '--model') && options?.settings?.model) {
    next.push('--model', options.settings.model);
  }
  return next;
}

function prepareCommand(
  runtime: Exclude<AgentRuntime, 'hermes'>,
  command: string,
  options?: AgentRunOptions,
): { executable: string; args: string[]; label: string } {
  const tokens = parseCommandLine(command.trim());
  if (tokens.length === 0) return { executable: '', args: [], label: '' };

  const executable = resolveExecutable(tokens[0]);
  const stem = executableStem(executable);
  let args = tokens.slice(1);

  if (runtime === 'codex' && stem === 'codex') args = applyCodexDefaults(args, options);
  if (runtime === 'claude_code' && stem === 'claude') args = applyClaudeDefaults(args, options);
  if (runtime === 'opencode' && stem === 'opencode') args = applyOpenCodeDefaults(args, options);

  return {
    executable,
    args,
    label: [executable, ...args].join(' '),
  };
}

function mergeModelOptions(values: Array<{ id: string; label?: string; source?: AgentModelOption['source']; isCurrentDefault?: boolean }>): AgentModelOption[] {
  const seen = new Set<string>();
  const options: AgentModelOption[] = [];

  for (const entry of values) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: entry.label?.trim() || id,
      source: entry.source ?? 'catalog',
      isCurrentDefault: entry.isCurrentDefault,
    });
  }

  return options;
}

function parseTomlStringValue(line: string): string | null {
  const match = line.match(/=\s*"([^"]+)"/);
  return match?.[1]?.trim() || null;
}

async function discoverCodexModels(command: string): Promise<AgentModelsResponse> {
  // Step 1: Read default model from ~/.codex/config.toml
  const configPath = join(homedir(), '.codex', 'config.toml');
  let defaultModel: string | null = null;
  try {
    const content = await readFile(configPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (/^\[/.test(trimmed)) break; // stop at first section
      if (trimmed.startsWith('model')) {
        defaultModel = parseTomlStringValue(trimmed) ?? defaultModel;
        break;
      }
    }
  } catch {
    // Best-effort only.
  }

  // Step 2: Run `codex debug models` to get the live catalog
  const tokens = parseCommandLine(command.trim());
  const executable = tokens.length > 0 ? resolveExecutable(tokens[0]) : 'codex';
  if (executableStem(executable) !== 'codex') {
    const fallback = mergeModelOptions(
      defaultModel ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }] : [],
    );
    return { runtime: 'codex', defaultModel, activeProvider: 'openai', groups: fallback.length > 0 ? [{ provider: 'Codex', models: fallback }] : [] };
  }

  try {
    const result = await runProcessCapture(
      executable,
      ['debug', 'models'],
      { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      resolveMinionsWorkspaceDir(),
    );

    if (result.code === 0 && result.stdout.trim()) {
      const parsed = JSON.parse(result.stdout.trim()) as {
        models: Array<{ slug: string; display_name?: string; visibility?: string }>;
      };

      const catalogModels = (parsed.models ?? [])
        .filter((m) => m.slug && m.visibility !== 'hide')
        .map((m) => ({
          id: m.slug,
          label: m.display_name?.trim() || m.slug,
          source: 'catalog' as const,
          isCurrentDefault: m.slug === defaultModel,
        }));

      const models = mergeModelOptions([
        ...(defaultModel && !catalogModels.some((m) => m.id === defaultModel)
          ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }]
          : []),
        ...catalogModels,
      ]);

      return {
        runtime: 'codex',
        defaultModel,
        activeProvider: 'openai',
        groups: models.length > 0 ? [{ provider: 'OpenAI (Codex)', models }] : [],
      };
    }
  } catch {
    // Fall through to static fallback.
  }

  // Step 3: Static fallback
  const fallbackModels = mergeModelOptions([
    ...(defaultModel ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }] : []),
    { id: 'gpt-5.5', label: 'GPT-5.5', source: 'catalog' as const },
    { id: 'gpt-5.4', label: 'GPT-5.4', source: 'catalog' as const },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', source: 'catalog' as const },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', source: 'catalog' as const },
    { id: 'gpt-5.2', label: 'GPT-5.2', source: 'catalog' as const },
  ]);

  return {
    runtime: 'codex',
    defaultModel,
    activeProvider: 'openai',
    groups: fallbackModels.length > 0 ? [{ provider: 'OpenAI (Codex)', models: fallbackModels }] : [],
  };
}

async function discoverClaudeModels(): Promise<AgentModelsResponse> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let defaultModel: string | null = null;
  let providerLabel = 'Claude Code';

  try {
    const raw = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    if (typeof parsed.env?.ANTHROPIC_MODEL === 'string' && parsed.env.ANTHROPIC_MODEL.trim()) {
      defaultModel = parsed.env.ANTHROPIC_MODEL.trim();
    }
    if (typeof parsed.env?.ANTHROPIC_BASE_URL === 'string' && parsed.env.ANTHROPIC_BASE_URL.trim()) {
      providerLabel = 'Claude Code Provider';
    }
  } catch {
    // Best-effort discovery only.
  }

  const models = mergeModelOptions([
    ...(defaultModel ? [{ id: defaultModel, source: 'current' as const, isCurrentDefault: true }] : []),
    { id: 'sonnet', label: 'sonnet', source: 'alias' },
    { id: 'opus', label: 'opus', source: 'alias' },
    { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', source: 'alias' },
  ]);

  return {
    runtime: 'claude_code',
    defaultModel,
    activeProvider: 'anthropic',
    groups: models.length > 0 ? [{ provider: providerLabel, models }] : [],
  };
}

async function runProcessCapture(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += stripAnsi(String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr += stripAnsi(String(chunk)); });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ stdout, stderr, code }));
  });
}

async function discoverOpenCodeModels(command: string): Promise<AgentModelsResponse> {
  const tokens = parseCommandLine(command.trim());
  const executable = tokens.length > 0 ? resolveExecutable(tokens[0]) : 'opencode';
  if (executableStem(executable) !== 'opencode') {
    return { runtime: 'opencode', defaultModel: null, activeProvider: 'opencode', groups: [] };
  }

  const dir = join(tmpdir(), 'minions-runtime-models', 'opencode', randomUUID());
  const xdgConfigHome = join(dir, 'config');
  const xdgDataHome = join(dir, 'data');
  await mkdir(xdgConfigHome, { recursive: true });
  await mkdir(xdgDataHome, { recursive: true });

  try {
    const result = await runProcessCapture(
      executable,
      ['models'],
      {
        ...process.env,
        TERM: 'dumb',
        NO_COLOR: '1',
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_DATA_HOME: xdgDataHome,
      },
      resolveMinionsWorkspaceDir(),
    );

    if (result.code !== 0) {
      return { runtime: 'opencode', defaultModel: null, activeProvider: 'opencode', groups: [] };
    }

    const grouped = new Map<string, AgentModelOption[]>();
    for (const line of result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      const [provider, ...rest] = line.split('/');
      const id = rest.join('/').trim();
      if (!provider || !id) continue;
      const models = grouped.get(provider) ?? [];
      models.push({ id: line, label: id, source: 'catalog' });
      grouped.set(provider, models);
    }

    return {
      runtime: 'opencode',
      defaultModel: null,
      activeProvider: grouped.keys().next().value ?? 'opencode',
      groups: [...grouped.entries()].map(([provider, models]) => ({ provider, models })),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class CommandRuntimeAdapter implements AgentAdapter {
  constructor(
    private readonly runtime: Exclude<AgentRuntime, 'hermes'>,
    private readonly command: string,
  ) {}

  async chat(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): Promise<{ text: string; sessionId: string }> {
    let text = '';
    let error: string | null = null;
    for await (const event of this.chatStream(sessionId, message, options)) {
      if (event.type === 'text_delta') text += event.content ?? '';
      if (event.type === 'error') error = event.error ?? 'Command runtime failed';
    }
    if (error) throw new Error(error);
    return { text, sessionId };
  }

  async *chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent> {
    if (!this.command.trim()) {
      yield {
        type: 'error',
        error: `${this.runtime} runtime is not configured. Set the corresponding MINIONS_*_COMMAND environment variable.`,
        code: 'runtime_not_configured',
      };
      yield { type: 'done', sessionId };
      return;
    }

    const queue = createAsyncQueue<StreamEvent>();
    const cwd = options?.task?.workspacePath ?? resolveMinionsWorkspaceDir();
    const startedAt = Date.now();

    void (async () => {
      const files = await writeTaskFiles(this.runtime, sessionId, message, options);
      const promptText = await readFile(files.promptFile, 'utf8');
      const xdgConfigHome = join(files.dir, 'xdg-config');
      const xdgDataHome = join(files.dir, 'xdg-data');
      await mkdir(xdgConfigHome, { recursive: true });
      await mkdir(xdgDataHome, { recursive: true });
      const prepared = prepareCommand(this.runtime, this.command, options);
      let stderrBuffer = '';
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(files.dir, { recursive: true, force: true }).catch(() => undefined);
      };

      queue.push({
        type: 'tool_progress',
        tool: 'process',
        status: 'running',
        label: prepared.label || this.command,
      });

      const child = spawn(prepared.executable, prepared.args, {
        cwd,
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(prepared.executable),
        env: {
          ...process.env,
          TERM: 'dumb',
          NO_COLOR: '1',
          MINIONS_RUNTIME: this.runtime,
          MINIONS_TASK_ID: options?.task?.id ?? sessionId,
          MINIONS_TASK_TITLE: options?.task?.title ?? '',
          MINIONS_TASK_REPO: options?.task?.workspacePath ?? '',
          MINIONS_TASK_MESSAGE: message,
          MINIONS_TASK_SYSTEM_PROMPT: options?.systemMessage ?? '',
          MINIONS_TASK_PROMPT_FILE: files.promptFile,
          MINIONS_TASK_CONTEXT_FILE: files.contextFile,
          XDG_CONFIG_HOME: this.runtime === 'opencode' ? xdgConfigHome : process.env.XDG_CONFIG_HOME,
          XDG_DATA_HOME: this.runtime === 'opencode' ? xdgDataHome : process.env.XDG_DATA_HOME,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        const text = stripAnsi(String(chunk));
        if (text) queue.push({ type: 'text_delta', content: text });
      });

      child.stderr.on('data', (chunk) => {
        const text = stripAnsi(String(chunk));
        stderrBuffer += text;
      });

      child.on('error', (error) => {
        queue.push({ type: 'error', error: error.message, code: 'runtime_spawn_error' });
      });

      child.stdin.write(promptText);
      child.stdin.end();

      child.on('close', (code) => {
        const duration = (Date.now() - startedAt) / 1000;
        if (code === 0) {
          queue.push({
            type: 'tool_progress',
            tool: 'process',
            status: 'completed',
            duration,
            label: prepared.label || this.command,
          });
          queue.push({ type: 'done', sessionId });
        } else {
          queue.push({
            type: 'tool_progress',
            tool: 'process',
            status: 'error',
            duration,
            label: prepared.label || this.command,
          });
          queue.push({
            type: 'error',
            error: stderrBuffer.trim() || `${this.runtime} command exited with code ${code ?? 'unknown'}`,
            code: 'runtime_exit_error',
          });
          queue.push({ type: 'done', sessionId });
        }
        queue.end();
        void cleanup();
      });
    })().catch((error) => {
      queue.push({ type: 'error', error: error instanceof Error ? error.message : String(error), code: 'runtime_setup_error' });
      queue.push({ type: 'done', sessionId });
      queue.end();
    });

    for await (const event of queue) {
      yield event;
    }
  }

  async healthCheck(): Promise<boolean> {
    if (!this.command.trim()) return false;
    const tokens = parseCommandLine(this.command.trim());
    if (tokens.length === 0) return false;
    const executable = resolveExecutable(tokens[0]);
    if (process.platform === 'win32') return executable !== tokens[0] || existsSync(executable);
    return true;
  }

  async getModels(): Promise<AgentModelsResponse> {
    if (this.runtime === 'codex') return await discoverCodexModels(this.command);
    if (this.runtime === 'claude_code') return await discoverClaudeModels();
    return await discoverOpenCodeModels(this.command);
  }

  async getMessages(_sessionId: string, _taskId: string): Promise<TaskMessage[]> {
    return [];
  }

  async getSessionMetadata(_sessionId: string): Promise<SessionMetadata | null> {
    return null;
  }

  async judgeCompletion(
    _taskTitle: string,
    _taskDescription: string | null,
    responseText: string,
  ): Promise<{ done: boolean; reason: string }> {
    // For command-backed runtimes, the CLI process completing successfully is the
    // completion signal. If we got any response text, the task is done.
    if (responseText.trim()) {
      return { done: true, reason: `${this.runtime} command completed` };
    }
    return { done: false, reason: 'no response text produced' };
  }
}
