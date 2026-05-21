import { Router } from 'express';
import { deleteTask, getAllTasks, getTask, insertTask, markTaskViewed, updateTask } from '../db/queries.js';
import { parseRunSettingsBody } from '../agent-settings.js';
import { broadcast } from '../events.js';
import { toErrorMessage } from '../errors.js';
import {
  buildTaskExecutionRequest,
  buildTaskPlanningRequest,
  buildTaskPlanningSystemPrompt,
} from '../prompts/task-agent.js';
import { defaultRuntime, parseRuntimeValue } from '../runtime-config.js';
import { startTaskRun } from '../task-runner.js';
import { parseWorkspacePath } from '../workspace-access.js';
import { TASK_KINDS, TASK_MODES, TASK_STATUSES } from '../../shared/types.js';
import type { TaskKind, TaskMode, TaskStatus } from '../../shared/types.js';
import {
  appendAttachmentContext,
  attachmentUploadMiddleware,
  cleanupUploadedAttachments,
  saveTaskAttachments,
  uploadedAttachments,
} from '../attachments.js';

export const tasksRouter = Router();

const LOW_INFORMATION_TITLES = new Set(['?', 'hi', 'hello', 'hey', 'yo']);

tasksRouter.get('/', (req, res) => {
  const status = req.query.status as TaskStatus | undefined;
  const tasks = getAllTasks(status);
  res.json({ tasks });
});

tasksRouter.get('/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});

function generateTitle(text: string): string {
  const firstLine = text.split(/\n/)[0].trim();
  const normalizedFirstLine = firstLine.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/g, '').trim();
  if (!normalizedFirstLine || LOW_INFORMATION_TITLES.has(normalizedFirstLine)) return 'Untitled task';

  const firstSentence = firstLine.split(/[.!?]/)[0].trim();
  if (!firstSentence) return text.slice(0, 60).trim() || 'Untitled task';
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + '...';
}

function parseTaskMode(value: unknown): TaskMode {
  if (value === undefined || value === null || value === '') return 'direct';
  if (typeof value !== 'string' || !(TASK_MODES as readonly string[]).includes(value)) {
    throw new Error(`taskMode must be one of: ${TASK_MODES.join(', ')}`);
  }
  return value as TaskMode;
}

function parseTaskKind(value: unknown): TaskKind {
  if (value === undefined || value === null || value === '') return 'task';
  if (typeof value !== 'string' || !(TASK_KINDS as readonly string[]).includes(value)) {
    throw new Error(`taskKind must be one of: ${TASK_KINDS.join(', ')}`);
  }
  return value as TaskKind;
}

tasksRouter.post('/', attachmentUploadMiddleware, async (req, res) => {
  const { description, title } = req.body;
  if (!description || typeof description !== 'string') {
    return res.status(400).json({ error: 'description is required' });
  }

  let workspacePath: string | null | undefined;
  let runtime: ReturnType<typeof parseRuntimeValue>;
  let runSettings: ReturnType<typeof parseRunSettingsBody>;
  let taskMode: TaskMode;
  let taskKind: TaskKind;
  try {
    workspacePath = parseWorkspacePath(req.body);
    runtime = parseRuntimeValue(req.body.runtime);
    runSettings = parseRunSettingsBody(req.body);
    taskMode = parseTaskMode(req.body.taskMode ?? req.body.task_mode);
    taskKind = parseTaskKind(req.body.taskKind ?? req.body.task_kind);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid task settings' });
  }

  const resolvedTitle = title && typeof title === 'string' && title.trim()
    ? title.trim()
    : generateTitle(description);
  let task = insertTask({
    title: resolvedTitle,
    description,
    status: 'pending',
    task_kind: taskKind,
    task_mode: taskMode,
    workspace_path: workspacePath ?? null,
    agent_runtime: runtime ?? runSettings.taskFields.agent_runtime ?? defaultRuntime(),
    agent_model: runSettings.taskFields.agent_model ?? null,
    reasoning_effort: runSettings.taskFields.reasoning_effort ?? null,
  });

  const files = uploadedAttachments(req);
  try {
    const attachments = await saveTaskAttachments(task.id, files);
    if (attachments.length > 0) {
      task = updateTask(task.id, {
        description: appendAttachmentContext(description, attachments),
      }) ?? task;
    }
  } catch (error) {
    deleteTask(task.id);
    return res.status(400).json({ error: toErrorMessage(error, 'Failed to save attachments') });
  } finally {
    await cleanupUploadedAttachments(files);
  }

  broadcast({ type: 'task_created', task });

  if (task.task_mode === 'plan') {
    try {
      startTaskRun(
        task,
        buildTaskPlanningRequest({ title: task.title, description: task.description }),
        {
          systemMessage: buildTaskPlanningSystemPrompt({
            title: task.title,
            description: task.description,
            workspacePath: task.workspace_path,
          }),
        },
      );
    } catch {
      // Keep the task in Pending even if the planning run cannot start immediately.
    }
  }

  res.status(201).json({ task });
});

tasksRouter.patch('/:id', (req, res) => {
  const allowed = ['title', 'description', 'status'] as const;
  const fields: Record<string, unknown> = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) fields[key] = req.body[key];
  }

  try {
    const workspacePath = parseWorkspacePath(req.body);
    if (workspacePath !== undefined) fields.workspace_path = workspacePath;
    const runtime = parseRuntimeValue(req.body.runtime);
    if (runtime !== undefined) fields.agent_runtime = runtime;
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid task settings' });
  }

  if (fields.status && !TASK_STATUSES.includes(fields.status as TaskStatus)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const updated = updateTask(req.params.id, fields);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });
  res.json({ task: updated });
});

tasksRouter.post('/:id/viewed', (req, res) => {
  const { task, changed } = markTaskViewed(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (changed) broadcast({ type: 'task_updated', task });
  res.json({ task });
});

tasksRouter.delete('/:id', (req, res) => {
  const deleted = deleteTask(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_deleted', taskId: req.params.id });
  res.json({ ok: true });
});

tasksRouter.post('/:id/move', (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${TASK_STATUSES.join(', ')}` });
  }

  const current = getTask(req.params.id);
  if (!current) return res.status(404).json({ error: 'Task not found' });

  const updated = updateTask(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_updated', task: updated });

  if (current.status === 'pending' && status === 'in_progress') {
    try {
      const activationPrompt = updated.task_mode === 'plan' && updated.last_agent_response_at !== null
        ? buildTaskExecutionRequest({ title: updated.title, description: updated.description })
        : (updated.description ?? updated.title);
      startTaskRun(updated, activationPrompt);
    } catch (error) {
      const reverted = updateTask(req.params.id, { status: current.status });
      if (reverted) broadcast({ type: 'task_updated', task: reverted });
      return res.status(409).json({
        error: toErrorMessage(error, 'Task was moved but could not be activated'),
      });
    }
  }

  res.json({ task: updated });
});
