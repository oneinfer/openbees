import type { ActivityIntentDecision, AgentModelsResponse, AgentRunSettings, ContextUsage, SessionMetadata, TaskMessage } from '../../shared/types.js';

export type { AgentRunSettings, ContextUsage };

export interface AgentRunOptions {
  systemMessage?: string;
  settings?: AgentRunSettings;
  task?: {
    id: string;
    title?: string | null;
    workspacePath?: string | null;
  };
}

export interface StreamEvent {
  type: 'text_delta' | 'thinking_delta' | 'tool_progress' | 'done' | 'error';
  content?: string;
  error?: string;
  code?: string;
  sessionId?: string;
  tool?: string;
  status?: 'running' | 'completed' | 'error';
  duration?: number;
  label?: string;
  details?: unknown;
  context?: ContextUsage | null;
}

export interface AgentAdapter {
  chat(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): Promise<{ text: string; sessionId: string }>;

  chatStream(
    sessionId: string,
    message: string,
    options?: AgentRunOptions,
  ): AsyncIterable<StreamEvent>;

  healthCheck(): Promise<boolean>;

  getModels(): Promise<AgentModelsResponse>;

  getMessages(sessionId: string, taskId: string): Promise<TaskMessage[]>;

  getSessionMetadata(sessionId: string): Promise<SessionMetadata | null>;

  judgeCompletion(
    taskTitle: string,
    taskDescription: string | null,
    responseText: string,
  ): Promise<{ done: boolean; reason: string }>;

  judgeActivityIntent(
    transcript: string,
    metadata?: {
      timestamp?: string | null;
      source?: string | null;
      capturedText?: string | null;
      activeWindow?: Record<string, unknown> | null;
      images?: Record<string, unknown> | null;
      model?: string | null;
      reasoningEffort?: AgentRunSettings['reasoningEffort'];
    },
  ): Promise<ActivityIntentDecision>;
}
