import {
  AGENT_RUNTIMES,
  type AgentRuntime,
  type AgentRuntimeInstallResponse,
  type AgentRuntimeModelControl,
  type AgentRuntimeOption,
  type AgentRuntimeReasoningControl,
  type AgentRuntimesResponse,
} from '../shared/types.js';
import { getAppSetting, setAppSetting } from './db/queries.js';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const DEFAULT_RUNTIME_SETTING_KEY = 'default_agent_runtime';

interface RuntimeDefinition {
  id: AgentRuntime;
  label: string;
  description: string;
  envCommand: string | null;
  modelControl: AgentRuntimeModelControl;
  reasoningControl: AgentRuntimeReasoningControl;
}

interface RuntimeInstaller {
  packageName: string;
  command: string[];
}

const RUNTIME_INSTALLERS: Partial<Record<AgentRuntime, RuntimeInstaller>> = {
  codex: {
    packageName: '@openai/codex',
    command: ['npm', 'install', '-g', '@openai/codex'],
  },
  claude_code: {
    packageName: '@anthropic-ai/claude-code',
    command: ['npm', 'install', '-g', '@anthropic-ai/claude-code'],
  },
  opencode: {
    packageName: 'opencode-ai',
    command: ['npm', 'install', '-g', 'opencode-ai'],
  },
};

const RUNTIME_DEFINITIONS: RuntimeDefinition[] = [
  {
    id: 'hermes',
    label: 'Hermes',
    description: 'Built-in Hermes worker with model and reasoning controls.',
    envCommand: process.env.HERMES_PYTHON?.trim() || process.env.HERMES_AGENT_DIR?.trim() || 'hermes',
    modelControl: 'picker',
    reasoningControl: 'picker',
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'Use the Codex CLI in the selected repo with optional model and reasoning effort overrides.',
    envCommand: process.env.MINIONS_CODEX_COMMAND?.trim() || 'codex',
    modelControl: 'picker',
    reasoningControl: 'picker',
  },
  {
    id: 'claude_code',
    label: 'Claude Code',
    description: 'Use the Claude Code CLI in the selected repo with optional model and effort overrides.',
    envCommand: process.env.MINIONS_CLAUDE_CODE_COMMAND?.trim() || 'claude',
    modelControl: 'picker',
    reasoningControl: 'picker',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'Use the OpenCode CLI in the selected repo with an optional model id override.',
    envCommand: process.env.MINIONS_OPENCODE_COMMAND?.trim() || 'opencode',
    modelControl: 'picker',
    reasoningControl: 'none',
  },
];

function isAgentRuntime(value: string | null): value is AgentRuntime {
  return value !== null && (AGENT_RUNTIMES as readonly string[]).includes(value);
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

function pathEnvValue(): string {
  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path');
  return entry?.[1] ?? '';
}

function pathextValues(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.PS1';
  return raw.split(';').map((item) => item.trim()).filter(Boolean);
}

function executableCandidates(command: string): string[] {
  const hasExtension = /\.[^./\\]+$/.test(command);
  const extensions = process.platform === 'win32' && !hasExtension ? pathextValues() : [''];

  if (command.includes('/') || command.includes('\\')) {
    const base = isAbsolute(command) ? command : resolve(process.cwd(), command);
    return extensions.map((extension) => `${base}${extension}`);
  }

  return pathEnvValue()
    .split(process.platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((dir) => extensions.map((extension) => join(dir, `${command}${extension}`)));
}

export function resolveRuntimeExecutable(command: string | null): string | null {
  if (!command?.trim()) return null;
  const tokens = parseCommandLine(command.trim());
  if (tokens.length === 0) return null;
  return executableCandidates(tokens[0]).find((candidate) => existsSync(candidate)) ?? null;
}

export function runtimeCommandAvailable(runtime: AgentRuntime): boolean {
  if (runtime === 'hermes') return true;
  return resolveRuntimeExecutable(runtimeCommand(runtime)) !== null;
}

export function runtimeInstaller(runtime: AgentRuntime): RuntimeInstaller | null {
  return RUNTIME_INSTALLERS[runtime] ?? null;
}

export function defaultRuntime(): AgentRuntime {
  const stored = getAppSetting(DEFAULT_RUNTIME_SETTING_KEY);
  if (isAgentRuntime(stored)) return stored;
  const envDefault = process.env.MINIONS_DEFAULT_RUNTIME?.trim() ?? null;
  if (isAgentRuntime(envDefault)) return envDefault;
  return 'hermes';
}

export function setDefaultRuntime(runtime: AgentRuntime | null): AgentRuntime {
  setAppSetting(DEFAULT_RUNTIME_SETTING_KEY, runtime);
  return defaultRuntime();
}

export function parseRuntimeValue(value: unknown): AgentRuntime | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !(AGENT_RUNTIMES as readonly string[]).includes(value)) {
    throw new Error(`runtime must be one of: ${AGENT_RUNTIMES.join(', ')}`);
  }
  return value as AgentRuntime;
}

export function runtimeCommand(runtime: Exclude<AgentRuntime, 'hermes'>): string | null {
  return RUNTIME_DEFINITIONS.find((entry) => entry.id === runtime)?.envCommand ?? null;
}

export function runtimeOptions(): AgentRuntimeOption[] {
  return RUNTIME_DEFINITIONS.map((entry) => ({
    ...runtimeOption(entry),
  }));
}

export function runtimesResponse(): AgentRuntimesResponse {
  return {
    defaultRuntime: defaultRuntime(),
    options: runtimeOptions(),
  };
}

function runtimeOption(entry: RuntimeDefinition): AgentRuntimeOption {
  const installer = runtimeInstaller(entry.id);
  const installed = runtimeCommandAvailable(entry.id);
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    status: installed ? 'ready' : 'configure',
    command: entry.id === 'hermes' ? null : entry.envCommand,
    installed,
    installable: Boolean(installer),
    packageName: installer?.packageName,
    installCommand: installer?.command.join(' '),
    modelControl: entry.modelControl,
    reasoningControl: entry.reasoningControl,
  };
}

export function runtimeInstallResponse(runtime: AgentRuntime, output?: string): AgentRuntimeInstallResponse | null {
  const installer = runtimeInstaller(runtime);
  if (!installer) return null;
  return {
    runtime,
    installed: runtimeCommandAvailable(runtime),
    command: runtimeCommand(runtime as Exclude<AgentRuntime, 'hermes'>),
    packageName: installer.packageName,
    installCommand: installer.command.join(' '),
    output,
  };
}
