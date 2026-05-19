import type { AgentRuntime, AgentDefaults, AgentModelsResponse, AgentRuntimesResponse } from '../../shared/types.js';
import { CommandRuntimeAdapter } from './command-runtime.js';
import type { AgentAdapter } from './types.js';
import { HermesWorkerAdapter } from './hermes-worker.js';
import { defaultRuntime, runtimeCommand, runtimesResponse } from '../runtime-config.js';

const FALLBACK_DEFAULTS: AgentDefaults = {
  runtime: 'hermes',
  provider: null,
  model: null,
  baseUrl: null,
  apiMode: null,
  reasoningEffort: 'medium',
  showReasoning: true,
};

export class AgentRegistry {
  readonly hermes = new HermesWorkerAdapter();

  private readonly runtimeAdapters = new Map<AgentRuntime, AgentAdapter>([
    ['hermes', this.hermes],
    ['codex', new CommandRuntimeAdapter('codex', runtimeCommand('codex') ?? '')],
    ['claude_code', new CommandRuntimeAdapter('claude_code', runtimeCommand('claude_code') ?? '')],
    ['opencode', new CommandRuntimeAdapter('opencode', runtimeCommand('opencode') ?? '')],
  ]);

  adapterFor(runtime: AgentRuntime | null | undefined): AgentAdapter {
    return this.runtimeAdapters.get(runtime ?? defaultRuntime()) ?? this.hermes;
  }

  defaultRuntime(): AgentRuntime {
    return defaultRuntime();
  }

  runtimes(): AgentRuntimesResponse {
    return runtimesResponse();
  }

  async modelsFor(runtime: AgentRuntime | null | undefined): Promise<AgentModelsResponse> {
    const target = runtime ?? defaultRuntime();
    return await this.adapterFor(target).getModels();
  }

  async defaults(): Promise<AgentDefaults> {
    try {
      const hermesDefaults = await this.hermes.getDefaults();
      return {
        ...hermesDefaults,
        runtime: defaultRuntime(),
      };
    } catch {
      return {
        ...FALLBACK_DEFAULTS,
        runtime: defaultRuntime(),
      };
    }
  }

  async health(): Promise<Record<AgentRuntime, boolean>> {
    const entries = await Promise.all(
      [...this.runtimeAdapters.entries()].map(async ([runtime, adapter]) => [runtime, await adapter.healthCheck()] as const),
    );
    return Object.fromEntries(entries) as Record<AgentRuntime, boolean>;
  }

  async stop(): Promise<void> {
    await this.hermes.stop();
  }
}
