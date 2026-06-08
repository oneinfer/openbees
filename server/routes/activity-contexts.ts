import { Router } from 'express';
import {
  deleteActivityContext,
  getActivityContext,
  getAllActivityContexts,
  getAppSetting,
  updateTask,
  updateActivityContextPromotedTask,
} from '../db/queries.js';
import { broadcast } from '../events.js';
import { createTaskRecord, startTaskImmediately } from '../task-service.js';
import { toErrorMessage } from '../errors.js';
import { getActiveActivityAgentSettings } from '../activity-agent-settings.js';
import { appendAttachmentContext, saveActivityImageAttachments } from '../attachments.js';
import { enrichImageAttachmentContext } from '../image-context.js';
import { CURRENT_PROJECT_SETTING_KEY } from './projects.js';
import { notifyTaskCreated } from '../native-notifications.js';
import type { ActivityContext } from '../../shared/types.js';

export const activityContextsRouter = Router();

activityContextsRouter.get('/', (_req, res) => {
  res.json({ contexts: getAllActivityContexts() });
});

activityContextsRouter.get('/:id', (req, res) => {
  const context = getActivityContext(req.params.id);
  if (!context) return res.status(404).json({ error: 'Activity context not found' });
  res.json({ context });
});

activityContextsRouter.delete('/:id', (req, res) => {
  const deleted = deleteActivityContext(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Activity context not found' });
  broadcast({ type: 'activity_context_deleted', contextId: req.params.id });
  res.json({ ok: true });
});

activityContextsRouter.post('/:id/promote', async (req, res) => {
  const context = getActivityContext(req.params.id);
  if (!context) return res.status(404).json({ error: 'Activity context not found' });

  const requestedTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const requestedDescription = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const description = requestedDescription || buildPromotedTaskDescription(context);
  if (!description.trim()) return res.status(400).json({ error: 'No context is available to promote' });

  try {
    const activeSettings = getActiveActivityAgentSettings();
    const workspacePath = getAppSetting(CURRENT_PROJECT_SETTING_KEY);
    let task = createTaskRecord({
      title: requestedTitle || normalizeSpokenInput(context.spoken_input) || context.decision?.title || undefined,
      description,
      status: 'pending',
      taskKind: 'task',
      taskMode: 'direct',
      workspacePath,
      runtime: activeSettings.runtime,
      model: activeSettings.model,
      reasoningEffort: activeSettings.reasoningEffort,
    });
    const attachments = await enrichImageAttachmentContext(
      await saveActivityImageAttachments(task.id, activityContextImageValues(context)),
    );
    if (attachments.length > 0) {
      task = updateTask(task.id, {
        description: appendAttachmentContext(description, attachments),
      }) ?? task;
    }
    task = startTaskImmediately(task);
    const updatedContext = updateActivityContextPromotedTask(context.id, task.id) ?? context;
    notifyTaskCreated(task);
    broadcast({ type: 'task_created', task });
    broadcast({ type: 'activity_context_updated', context: updatedContext });
    res.status(201).json({ task, context: updatedContext });
  } catch (error) {
    res.status(409).json({ error: toErrorMessage(error, 'Failed to promote activity context') });
  }
});

function buildPromotedTaskDescription(context: ActivityContext): string {
  const taskText = normalizeSpokenInput(context.spoken_input);
  const capturedText = context.captured_text?.trim() || '';
  const userRequest = taskText || capturedText || context.decision?.title || '';
  const imageValues = activityContextImageValues(context);
  const sections = [`User request:\n${userRequest || (imageValues.length > 0 ? 'Captured screen context.' : '')}`];

  if (capturedText && capturedText !== userRequest) {
    sections.push(`Captured selected text:\n${capturedText}`);
  }

  const windowContext = activeWindowContext(context);
  if (windowContext) {
    sections.push(`Active window:\n${windowContext}`);
  }

  if (imageValues.length > 0) {
    sections.push('Captured image context is available for inspection:\nUse the attached image and its visual summary when it is relevant.');
  }

  return sections.filter((section) => section.trim()).join('\n\n');
}

function activityContextImageValues(context: ActivityContext): unknown[] {
  return [
    context.images?.selection_crop,
    context.images?.screenshot,
    context.images?.cursor_crop,
  ].filter(Boolean);
}

function normalizeSpokenInput(value: string | null): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '[input pending]' ? '' : trimmed;
}

function activeWindowContext(context: ActivityContext): string {
  const window = context.active_window;
  if (!window) return '';

  const pieces = [
    compactSingleLine(window.app_name),
    compactSingleLine(window.title),
    compactSingleLine(window.process_name),
  ].filter(Boolean);

  return [...new Set(pieces)].join(' - ');
}

function compactSingleLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
