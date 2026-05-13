import type {
  AgentDefaults,
  AgentModelsResponse,
  CronJob,
  CronRun,
  SessionMetadata,
  TaskMessage,
  ContextUsage,
} from '../../shared/types.js';
import type { AgentRunSettings } from './types.js';

export type WorkerRequest =
  | { id: string; type: 'health' }
  | { id: string; type: 'settings.get' }
  | { id: string; type: 'settings.set'; model?: string | null; reasoningEffort?: string | null }
  | { id: string; type: 'models.list' }
  | { id: string; type: 'cron.jobs.list'; includeDisabled?: boolean }
  | { id: string; type: 'cron.jobs.get'; jobId: string }
  | { id: string; type: 'cron.jobs.runs'; jobId: string; limit?: number }
  | { id: string; type: 'cron.jobs.run.content'; jobId: string; runId: string }
  | { id: string; type: 'cron.jobs.pause'; jobId: string; reason?: string }
  | { id: string; type: 'cron.jobs.resume'; jobId: string }
  | { id: string; type: 'cron.jobs.run'; jobId: string }
  | { id: string; type: 'cron.jobs.remove'; jobId: string }
  | { id: string; type: 'cron.tick' }
  | { id: string; type: 'session.messages.get'; sessionId: string; taskId?: string }
  | { id: string; type: 'session.get'; sessionId: string }
  | {
      id: string;
      type: 'chat';
      sessionId: string;
      message: string;
      systemMessage?: string;
      settings: AgentRunSettings;
      taskId?: string;
      taskTitle?: string | null;
    }
  | {
      id: string;
      type: 'judge.completion';
      taskTitle: string;
      taskDescription?: string | null;
      responseText: string;
    };

export interface WorkerErrorPayload {
  message: string;
  code?: string;
  hint?: string;
}

export type WorkerResult =
  | { ok: boolean; agentDir?: string | null; python?: string | null }
  | AgentDefaults
  | AgentModelsResponse
  | { jobs: CronJob[] }
  | { job: CronJob | null }
  | { runs: CronRun[] }
  | { content: string }
  | { executed: number }
  | { messages: TaskMessage[] }
  | { session: SessionMetadata | null }
  | { done: boolean; reason: string };

export type WorkerEvent =
  | { id: string; type: 'result'; data: WorkerResult }
  | { id: string; type: 'text_delta'; content?: string }
  | { id: string; type: 'thinking_delta'; content?: string }
  | {
      id: string;
      type: 'tool_progress';
      tool?: string;
      status?: 'running' | 'completed' | 'error';
      duration?: number;
      label?: string | null;
    }
  | { id: string; type: 'done'; sessionId?: string; context?: ContextUsage | null }
  | { id: string; type: 'error'; error: string | WorkerErrorPayload };
