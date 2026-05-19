import { Router } from 'express';
import { contextFromTask, getTask, getTaskMessages, updateTask } from '../db/queries.js';
import { agents } from '../app.js';
import { broadcast, initSSE } from '../events.js';
import {
  getRun,
  getRunContext,
  getRunStatus,
  sendSnapshot,
  subscribe,
} from '../live-chat.js';
import { parseRunSettingsBody } from '../agent-settings.js';
import { toErrorMessage } from '../errors.js';
import { startTaskRun } from '../task-runner.js';
import type { Task } from '../../shared/types.js';

export const chatRouter = Router();

function hasNoSession(task: Task): boolean {
  if (task.last_agent_response_at !== null) return false;
  return getRunStatus(task.id)?.status !== 'streaming';
}

chatRouter.get('/:id/messages', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const liveContext = getRunContext(task.id);
  const context = liveContext !== undefined ? liveContext : contextFromTask(task);
  if (hasNoSession(task)) return res.json({ messages: [], context });

  try {
    const messages = task.agent_runtime && task.agent_runtime !== 'hermes'
      ? getTaskMessages(task.id)
      : await agents.adapterFor(task.agent_runtime).getMessages(task.id, task.id);
    res.json({ messages, context });
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'Task session history unavailable') });
  }
});

chatRouter.get('/:id/session', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (hasNoSession(task)) return res.json({ session: null });

  try {
    const session = await agents.adapterFor(task.agent_runtime).getSessionMetadata(task.id);
    res.json({ session });
  } catch (error) {
    res.status(503).json({ error: toErrorMessage(error, 'Task session metadata unavailable') });
  }
});

chatRouter.post('/:id/messages', async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.status === 'pending') {
    return res.status(409).json({ error: 'Move this task to In Progress before sending messages' });
  }

  const { content } = req.body;
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }

  let runSettings: ReturnType<typeof parseRunSettingsBody>;
  try {
    runSettings = parseRunSettingsBody(req.body);
  } catch (error) {
    return res.status(400).json({ error: toErrorMessage(error, 'Invalid run settings') });
  }

  let runTask = task;
  if (runSettings.hasFields) {
    const { taskFields } = runSettings;
    const changed =
      (taskFields.agent_runtime !== undefined && taskFields.agent_runtime !== task.agent_runtime) ||
      (taskFields.agent_model !== undefined && taskFields.agent_model !== task.agent_model) ||
      (taskFields.reasoning_effort !== undefined && taskFields.reasoning_effort !== task.reasoning_effort);
    if (changed) {
      const updated = updateTask(task.id, taskFields);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      runTask = updated;
      broadcast({ type: 'task_updated', task: updated });
    }
  }

  try {
    const run = startTaskRun(runTask, content);
    res.status(202).json({ runId: run.runId, run });
  } catch (error) {
    res.status(409).json({ error: toErrorMessage(error, 'Failed to start task run') });
  }
});

chatRouter.get('/:id/live', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  initSSE(res);
  subscribe(task.id, res);

  const run = getRun(task.id);
  if (run) sendSnapshot(res, run);
});
