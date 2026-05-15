import { Router } from 'express';
import { getTask } from '../db/queries.js';
import { isRecord, toErrorMessage } from '../errors.js';
import { taskRunSettings } from '../agent-settings.js';
import { AGENT_RUNTIMES, REASONING_EFFORTS } from '../../shared/types.js';
import type { AgentDefaults, AgentRuntime, Task, TaskAgentSettings, ReasoningEffort } from '../../shared/types.js';
import type { AgentRegistry } from '../adapters/registry.js';
import { setDefaultRuntime } from '../runtime-config.js';

const FALLBACK_DEFAULTS: AgentDefaults = {
  runtime: 'hermes',
  provider: null,
  model: null,
  baseUrl: null,
  apiMode: null,
  reasoningEffort: 'medium',
  showReasoning: true,
};

async function defaultsForSettings(agents: AgentRegistry): Promise<AgentDefaults> {
  try {
    return await agents.defaults();
  } catch {
    return FALLBACK_DEFAULTS;
  }
}

function buildTaskSettings(task: Task, defaults: AgentDefaults, agents: AgentRegistry): TaskAgentSettings {
  const overrides = taskRunSettings(task);
  const effectiveRuntime = overrides.runtime ?? defaults.runtime ?? 'hermes';
  return {
    task: {
      runtime: overrides.runtime ?? null,
      model: overrides.model ?? null,
      reasoningEffort: overrides.reasoningEffort ?? null,
    },
    defaults,
    runtimes: agents.runtimes(),
    effective: {
      runtime: effectiveRuntime,
      model: overrides.model ?? defaults.model,
      provider: defaults.provider,
      reasoningEffort: overrides.reasoningEffort ?? defaults.reasoningEffort,
    },
  };
}

export function createAgentRouter(agents: AgentRegistry): Router {
  const router = Router();

  router.get('/defaults', async (_req, res) => {
    try {
      res.json(await agents.defaults());
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Agent defaults unavailable') });
    }
  });

  router.patch('/defaults', async (req, res) => {
    if (!isRecord(req.body)) {
      return res.status(400).json({ error: 'Request body is required' });
    }

    const updates: { model?: string | null; reasoningEffort?: string | null } = {};
    let nextRuntime: AgentRuntime | null | undefined;

    if ('runtime' in req.body) {
      const runtime = req.body.runtime;
      if (runtime !== null && (typeof runtime !== 'string' || !(AGENT_RUNTIMES as readonly string[]).includes(runtime))) {
        return res.status(400).json({ error: `runtime must be one of: ${AGENT_RUNTIMES.join(', ')}` });
      }
      nextRuntime = runtime as AgentRuntime | null;
    }

    if ('model' in req.body) {
      const model = req.body.model;
      if (model !== null && typeof model !== 'string') {
        return res.status(400).json({ error: 'model must be a string or null' });
      }
      updates.model = typeof model === 'string' ? model.trim() || null : null;
    }

    if ('reasoningEffort' in req.body) {
      const effort = req.body.reasoningEffort;
      if (effort !== null && (typeof effort !== 'string' || !(REASONING_EFFORTS as readonly string[]).includes(effort))) {
        return res.status(400).json({ error: `reasoningEffort must be one of: ${REASONING_EFFORTS.join(', ')}` });
      }
      updates.reasoningEffort = effort as ReasoningEffort | null;
    }

    try {
      if (nextRuntime !== undefined) setDefaultRuntime(nextRuntime);
      const defaults = Object.keys(updates).length > 0
        ? await agents.hermes.setDefaults(updates)
        : await agents.defaults();
      res.json({
        ...defaults,
        runtime: agents.defaultRuntime(),
      });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Failed to update defaults') });
    }
  });

  router.get('/models', async (req, res) => {
    const runtimeValue = typeof req.query.runtime === 'string' ? req.query.runtime : null;
    if (runtimeValue !== null && !(AGENT_RUNTIMES as readonly string[]).includes(runtimeValue)) {
      return res.status(400).json({ error: `runtime must be one of: ${AGENT_RUNTIMES.join(', ')}` });
    }

    try {
      res.json(await agents.modelsFor((runtimeValue as AgentRuntime | null) ?? agents.defaultRuntime()));
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Model discovery unavailable') });
    }
  });

  router.get('/runtimes', (_req, res) => {
    res.json(agents.runtimes());
  });

  return router;
}

export function createTaskAgentSettingsRouter(agents: AgentRegistry): Router {
  const router = Router();

  router.get('/:id/agent-settings', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const defaults = await defaultsForSettings(agents);
    res.json(buildTaskSettings(task, defaults, agents));
  });

  return router;
}
