import { defaultRuntime } from './runtime-config.js';
import type { AgentRuntime, ReasoningEffort } from '../shared/types.js';

export interface ActivityAgentSettings {
  runtime: AgentRuntime;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  updatedAt: number;
}

let activeSettings: ActivityAgentSettings | null = null;

export function setActiveActivityAgentSettings(settings: {
  runtime?: AgentRuntime | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}): ActivityAgentSettings {
  activeSettings = {
    runtime: settings.runtime ?? defaultRuntime(),
    model: settings.model?.trim() || null,
    reasoningEffort: settings.reasoningEffort ?? null,
    updatedAt: Date.now(),
  };
  return activeSettings;
}

export function getActiveActivityAgentSettings(): ActivityAgentSettings {
  return activeSettings ?? {
    runtime: defaultRuntime(),
    model: null,
    reasoningEffort: null,
    updatedAt: 0,
  };
}
