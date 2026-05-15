import {
  AGENT_RUNTIMES,
  type AgentRuntime,
  type AgentRuntimeModelControl,
  type AgentRuntimeOption,
  type AgentRuntimeReasoningControl,
  type AgentRuntimesResponse,
} from '../shared/types.js';
import { getAppSetting, setAppSetting } from './db/queries.js';

const DEFAULT_RUNTIME_SETTING_KEY = 'default_agent_runtime';

interface RuntimeDefinition {
  id: AgentRuntime;
  label: string;
  description: string;
  envCommand: string | null;
  modelControl: AgentRuntimeModelControl;
  reasoningControl: AgentRuntimeReasoningControl;
}

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
    id: entry.id,
    label: entry.label,
    description: entry.description,
    status: entry.id === 'hermes' || entry.envCommand ? 'ready' : 'configure',
    command: entry.id === 'hermes' ? null : entry.envCommand,
    modelControl: entry.modelControl,
    reasoningControl: entry.reasoningControl,
  }));
}

export function runtimesResponse(): AgentRuntimesResponse {
  return {
    defaultRuntime: defaultRuntime(),
    options: runtimeOptions(),
  };
}
