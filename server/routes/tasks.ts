import { Router } from 'express';
import { deleteTask, getAllTasks, getRecentTaskByDescription, getTask, markTaskViewed, saveProject, setAppSetting, updateTask } from '../db/queries.js';
import { parseRunSettingsBody } from '../agent-settings.js';
import { broadcast } from '../events.js';
import { toErrorMessage } from '../errors.js';
import { defaultRuntime, parseRuntimeValue } from '../runtime-config.js';
import { parseWorkspacePath } from '../workspace-access.js';
import { CURRENT_PROJECT_SETTING_KEY } from './projects.js';
import { TASK_KINDS, TASK_MODES, TASK_STATUSES } from '../../shared/types.js';
import type { TaskKind, TaskMode, TaskStatus } from '../../shared/types.js';
import { createTaskRecord, generateTaskTitle, startTaskActivationRun, startTaskImmediately, startTaskPlanningRun } from '../task-service.js';
import {
  appendAttachmentContext,
  attachmentUploadMiddleware,
  cleanupUploadedAttachments,
  deleteTaskAttachments,
  saveTaskAttachments,
  uploadedAttachments,
} from '../attachments.js';
import { enrichImageAttachmentContext } from '../image-context.js';
import { notifyTaskCreated } from '../native-notifications.js';

export const tasksRouter = Router();

const RECENT_TASK_DEDUPE_MS = 10_000;

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

function parseBooleanFlag(value: unknown, fieldName: string): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a boolean`);

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${fieldName} must be a boolean`);
}

tasksRouter.post('/', attachmentUploadMiddleware, async (req, res) => {
  const files = uploadedAttachments(req);
  const { description, title } = req.body;
  if (!description || typeof description !== 'string') {
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: 'description is required' });
  }

  let shouldStart: boolean;
  try {
    shouldStart = parseBooleanFlag(req.body.start ?? req.body.startImmediately ?? req.body.run, 'start');
  } catch (error) {
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid task settings' });
  }

  const recentDuplicate = files.length === 0
    ? getRecentTaskByDescription(description, Date.now() - RECENT_TASK_DEDUPE_MS)
    : undefined;
  if (recentDuplicate) {
    if (shouldStart && recentDuplicate.status === 'pending') {
      try {
        const started = startTaskImmediately(recentDuplicate);
        broadcast({ type: 'task_updated', task: started });
        return res.status(200).json({ task: started, duplicate: true });
      } catch (error) {
        return res.status(409).json({
          error: toErrorMessage(error, 'Task already exists but could not be activated'),
        });
      }
    }
    return res.status(200).json({ task: recentDuplicate, duplicate: true });
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
    await cleanupUploadedAttachments(files);
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid task settings' });
  }

  const resolvedTitle = title && typeof title === 'string' && title.trim()
    ? title.trim()
    : generateTaskTitle(description);
  let task = createTaskRecord({
    title: resolvedTitle,
    description,
    status: 'pending',
    taskKind,
    taskMode,
    workspacePath: workspacePath ?? null,
    runtime: runtime ?? runSettings.taskFields.agent_runtime ?? defaultRuntime(),
    model: runSettings.taskFields.agent_model ?? null,
    reasoningEffort: runSettings.taskFields.reasoning_effort ?? null,
  });

  try {
    const attachments = await enrichImageAttachmentContext(await saveTaskAttachments(task.id, files));
    if (attachments.length > 0) {
      task = updateTask(task.id, {
        description: appendAttachmentContext(description, attachments),
      }) ?? task;
    }
  } catch (error) {
    deleteTask(task.id);
    await deleteTaskAttachments(task.id).catch(() => undefined);
    return res.status(400).json({ error: toErrorMessage(error, 'Failed to save attachments') });
  } finally {
    await cleanupUploadedAttachments(files);
  }

  if (task.workspace_path) {
    const project = saveProject({ path: task.workspace_path });
    setAppSetting(CURRENT_PROJECT_SETTING_KEY, task.workspace_path);
    broadcast({ type: 'project_saved', project });
  }

  if (shouldStart) {
    try {
      task = startTaskImmediately(task);
    } catch (error) {
      const reverted = updateTask(task.id, { status: 'pending' }) ?? task;
      notifyTaskCreated(reverted);
      broadcast({ type: 'task_created', task: reverted });
      return res.status(409).json({
        error: toErrorMessage(error, 'Task was created but could not be activated'),
      });
    }
  }

  notifyTaskCreated(task);
  broadcast({ type: 'task_created', task });

  if (!shouldStart && task.task_mode === 'plan') {
    try {
      startTaskPlanningRun(task);
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

tasksRouter.delete('/:id', async (req, res) => {
  const taskId = req.params.id;
  const deleted = deleteTask(taskId);
  if (!deleted) return res.status(404).json({ error: 'Task not found' });
  await deleteTaskAttachments(taskId).catch((error) => {
    console.warn(`Failed to delete attachments for task ${taskId}:`, error);
  });
  broadcast({ type: 'task_deleted', taskId });
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
      startTaskActivationRun(updated);
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
