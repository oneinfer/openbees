import type { Request } from 'express';
import { agents } from './app.js';
import { getTask, recordAgentResponse, appendTaskMessage, updateTask } from './db/queries.js';
import { broadcast } from './events.js';
import {
  applyEvent,
  broadcast as broadcastLive,
  finishRun,
  getRunStatus,
  startRun,
} from './live-chat.js';
import { taskRunSettings } from './agent-settings.js';
import { buildTaskAgentSystemPrompt } from './prompts/task-agent.js';
import { toErrorMessage } from './errors.js';
import { liveTts } from './tts/live-tts.js';
import { enterpriseJson, organizationIdFromRequest } from './enterprise-client.js';
import type { ContextUsage, LiveChatRun, Task } from '../shared/types.js';
import type { StreamEvent } from './adapters/types.js';

const DONE_SNAPSHOT_TTL_MS = 30_000;
const ERROR_SNAPSHOT_TTL_MS = 5 * 60_000;

async function persistEnterpriseMessage(
  req: Request,
  taskId: string,
  role: 'user' | 'assistant',
  content: string,
  thinking?: string,
  context?: { used_tokens: number; window_tokens: number } | null,
): Promise<void> {
  const organizationId = organizationIdFromRequest(req);
  if (!organizationId) return;

  const form = new FormData();
  form.append('content', content);
  form.append('role', role);
  if (thinking) form.append('thinking', thinking);
  if (context) {
    form.append('context_used_tokens', String(context.used_tokens));
    form.append('context_window_tokens', String(context.window_tokens));
  }

  await enterpriseJson(
    req,
    `/organization/${encodeURIComponent(organizationId)}/tasks/${encodeURIComponent(taskId)}/messages`,
    { method: 'POST', body: form },
  );
}

async function consumeEnterpriseRun(
  req: Request,
  runTask: Task,
  content: string,
  runId: string,
  startedAt: number,
): Promise<void> {
  let sawDone = false;
  let doneEvent: StreamEvent | null = null;
  let doneContext: ContextUsage | null = null;
  let responseText = '';
  let thinkingText = '';
  const adapter = agents.adapterFor(runTask.agent_runtime);
  const sessionId = runTask.id;

  try {
    const stream = adapter.chatStream(sessionId, content, {
      systemMessage: buildTaskAgentSystemPrompt({
        title: runTask.title,
        description: runTask.description,
        workspacePath: runTask.workspace_path,
      }),
      settings: taskRunSettings(runTask),
      task: { id: runTask.id, title: runTask.title, workspacePath: runTask.workspace_path },
    });

    for await (const event of stream) {
      if (event.type === 'text_delta') {
        liveTts.acceptDelta(runTask.id, event.content ?? '');
        if (responseText.length < 4200) responseText += event.content ?? '';
      }
      if (event.type === 'thinking_delta' && thinkingText.length < 4200) thinkingText += event.content ?? '';
      if (event.type === 'done') {
        sawDone = true;
        doneEvent = event;
        doneContext = event.context ?? null;
        liveTts.end(runTask.id);
        continue;
      }
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
    }
  } catch (error) {
    const event: StreamEvent = { type: 'error', error: toErrorMessage(error, 'Agent stream failed') };
    applyEvent(runTask.id, event);
    broadcastLive(runTask.id, event);
    liveTts.end(runTask.id);
  } finally {
    const currentRun = getRunStatus(runTask.id);
    if (!sawDone && currentRun?.status === 'streaming') {
      doneEvent = { type: 'done', sessionId };
      sawDone = true;
    }

    if (sawDone && doneEvent && currentRun?.status === 'streaming') {
      try {
        if (responseText || thinkingText) {
          await persistEnterpriseMessage(
            req,
            runTask.id,
            'assistant',
            responseText,
            thinkingText,
            doneContext,
          );
        }
        applyEvent(runTask.id, doneEvent);
        broadcastLive(runTask.id, doneEvent);
        liveTts.end(runTask.id);
      } catch (error) {
        const persistenceError: StreamEvent = {
          type: 'error',
          error: toErrorMessage(error, 'Agent response could not be saved'),
        };
        applyEvent(runTask.id, persistenceError);
        broadcastLive(runTask.id, persistenceError);
      }
    }

    const finishedRun = getRunStatus(runTask.id);
    if (finishedRun) broadcast({ type: 'task_run_updated', run: finishedRun });

    if (sawDone && finishedRun?.status === 'done') {
      const responseAt = Date.now();

      const updated = recordAgentResponse(runTask.id, responseAt, doneContext);
      if (updated) {
        broadcast({ type: 'task_updated', task: updated });
        if (updated.agent_runtime && updated.agent_runtime !== 'hermes') {
          appendTaskMessage(runTask.id, 'user', content, null, startedAt);
          appendTaskMessage(runTask.id, 'assistant', responseText, thinkingText, responseAt);
        }
      }
    } else {
      const current = getTask(runTask.id);
      if (current) broadcast({ type: 'task_updated', task: current });
    }

    const ttl = finishedRun?.status === 'error' ? ERROR_SNAPSHOT_TTL_MS : DONE_SNAPSHOT_TTL_MS;
    finishRun(runTask.id, ttl, runId);
  }
}

export async function startEnterpriseTaskRun(
  req: Request,
  task: Task,
  content: string,
  options: { persistUserMessage?: boolean } = {},
): Promise<LiveChatRun> {
  const activeRun = getRunStatus(task.id);
  if (activeRun?.status === 'streaming') {
    throw new Error('This task already has a message in progress');
  }

  if (options.persistUserMessage !== false) {
    await persistEnterpriseMessage(req, task.id, 'user', content);
  }

  // Transition task to in_progress locally
  const started = updateTask(task.id, { status: 'in_progress' }) ?? task;
  broadcast({ type: 'task_updated', task: started });

  const run = startRun(task.id, task.id, content);
  const startedRun = getRunStatus(task.id);
  if (startedRun) broadcast({ type: 'task_run_updated', run: startedRun });
  broadcastLive(task.id, { type: 'snapshot', run });

  void consumeEnterpriseRun(req, started, content, run.runId, run.startedAt);
  return run;
}
