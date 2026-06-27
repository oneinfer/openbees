import { agents } from './app.js';
import { appendTaskMessage, getTask, recordAgentResponse, touchTask, updateTask } from './db/queries.js';
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
import type { StreamEvent } from './adapters/types.js';
import type { ContextUsage, LiveChatRun, Task } from '../shared/types.js';

const DONE_SNAPSHOT_TTL_MS = 30_000;
const ERROR_SNAPSHOT_TTL_MS = 5 * 60_000;

export async function judgeTaskCompletion(task: Task, responseText: string, responseAt: number): Promise<void> {
  if (!responseText.trim() || task.status !== 'in_progress') return;

  try {
    const result = await agents.adapterFor(task.agent_runtime).judgeCompletion(task.title, task.description, responseText);
    if (!result.done) return;

    const current = getTask(task.id);
    if (
      !current ||
      current.status !== 'in_progress' ||
      current.last_agent_response_at !== responseAt
    ) {
      return;
    }

    const updated = updateTask(task.id, { status: 'in_review' });
    if (updated) broadcast({ type: 'task_updated', task: updated });
  } catch {
    // Judge failure is non-critical; leave task as-is.
  }
}

async function consumeChatRun(
  runTask: Task,
  sessionId: string,
  content: string,
  runId: string,
  startedAt: number,
  systemMessage?: string,
): Promise<void> {
  let sawDone = false;
  let doneContext: ContextUsage | null | undefined;
  let responseText = '';
  let thinkingText = '';
  const adapter = agents.adapterFor(runTask.agent_runtime);

  try {
    const stream = adapter.chatStream(sessionId, content, {
      systemMessage: systemMessage ?? buildTaskAgentSystemPrompt({
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
        doneContext = event.context;
        liveTts.end(runTask.id);
      }
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
      liveTts.end(runTask.id);
    }
  } catch (error) {
    const event: StreamEvent = { type: 'error', error: toErrorMessage(error, 'Hermes chat stream failed') };
    applyEvent(runTask.id, event);
    broadcastLive(runTask.id, event);
    liveTts.end(runTask.id);
  } finally {
    const currentRun = getRunStatus(runTask.id);
    if (!sawDone && currentRun?.status === 'streaming') {
      const event: StreamEvent = { type: 'done', sessionId };
      sawDone = true;
      applyEvent(runTask.id, event);
      broadcastLive(runTask.id, event);
      liveTts.end(runTask.id);
    }

    const finishedRun = getRunStatus(runTask.id);
    if (finishedRun) broadcast({ type: 'task_run_updated', run: finishedRun });

    if (sawDone && finishedRun?.status === 'done') {
      const responseAt = Date.now();
      const updated = recordAgentResponse(runTask.id, responseAt, doneContext ?? null);
      if (!updated) {
        finishRun(runTask.id, DONE_SNAPSHOT_TTL_MS, runId);
        return;
      }

      broadcast({ type: 'task_updated', task: updated });
      if (updated.agent_runtime && updated.agent_runtime !== 'hermes') {
        appendTaskMessage(runTask.id, 'user', content, null, startedAt);
        appendTaskMessage(runTask.id, 'assistant', responseText, thinkingText, responseAt);
      }

      void judgeTaskCompletion(updated, responseText, responseAt);
    } else {
      touchTask(runTask.id);
    }

    const ttl = finishedRun?.status === 'error' ? ERROR_SNAPSHOT_TTL_MS : DONE_SNAPSHOT_TTL_MS;
    finishRun(runTask.id, ttl, runId);
  }
}

export function startTaskRun(task: Task, content: string, options?: { systemMessage?: string }): LiveChatRun {
  const activeRun = getRunStatus(task.id);
  if (activeRun?.status === 'streaming') {
    throw new Error('This task already has a message in progress');
  }

  const sessionId = task.id;
  const run = startRun(task.id, sessionId, content);
  const startedRun = getRunStatus(task.id);
  if (startedRun) broadcast({ type: 'task_run_updated', run: startedRun });
  broadcastLive(task.id, { type: 'snapshot', run });
  void consumeChatRun(task, sessionId, content, run.runId, run.startedAt, options?.systemMessage);
  return run;
}
