import type { Task } from '@shared/types';

export function hasUnseenAgentResponse(task: Task): boolean {
  return (
    task.last_agent_response_at !== null &&
    (task.last_viewed_at === null ||
      task.last_viewed_at < task.last_agent_response_at)
  );
}

export function isChatTask(task: Task): boolean {
  return task.task_kind === 'chat';
}

export function isBoardTask(task: Task): boolean {
  return !isChatTask(task);
}
