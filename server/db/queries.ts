import { v4 as uuid } from 'uuid';
import db from './index.js';
import {
  type Task,
  type TaskStatus,
  type TaskKind,
  type TaskMode,
  type ReasoningEffort,
  type ContextUsage,
  type AgentRuntime,
  type TaskMessage,
  type Project,
} from '../../shared/types.js';

const stmtAllProjects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC');
const stmtGetProject = db.prepare('SELECT * FROM projects WHERE path = ?');
const stmtDeleteProject = db.prepare('DELETE FROM projects WHERE path = ?');
const stmtInsertProject = db.prepare(`
  INSERT INTO projects (path, label, created_at, updated_at)
  VALUES (@path, @label, @created_at, @updated_at)
  ON CONFLICT(path) DO UPDATE SET
    label = excluded.label,
    updated_at = excluded.updated_at
`);
const stmtAllTasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC');
const stmtTasksByStatus = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC');
const stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?');
const stmtTaskIdsByWorkspacePath = db.prepare('SELECT id FROM tasks WHERE workspace_path = ?');
const stmtInsertTask = db.prepare(`
  INSERT INTO tasks (
    id, title, description, status, task_kind, task_mode, workspace_path, agent_runtime, agent_model, reasoning_effort,
    created_at, updated_at, last_agent_response_at, last_viewed_at,
    last_context_used_tokens, last_context_window_tokens
  )
  VALUES (
    @id, @title, @description, @status, @task_kind, @task_mode, @workspace_path, @agent_runtime, @agent_model, @reasoning_effort,
    @created_at, @updated_at, @last_agent_response_at, @last_viewed_at,
    @last_context_used_tokens, @last_context_window_tokens
  )
`);
const stmtDeleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');
const stmtDeleteTasksByWorkspacePath = db.prepare('DELETE FROM tasks WHERE workspace_path = ?');
const stmtTouchTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
const stmtMarkTaskViewed = db.prepare(`
  UPDATE tasks
  SET last_viewed_at = last_agent_response_at
  WHERE id = ?
    AND last_agent_response_at IS NOT NULL
    AND (last_viewed_at IS NULL OR last_viewed_at < last_agent_response_at)
`);
const stmtGetAppSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const stmtSetAppSetting = db.prepare(`
  INSERT INTO app_settings (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const stmtDeleteAppSetting = db.prepare('DELETE FROM app_settings WHERE key = ?');
const stmtGetTaskMessages = db.prepare('SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC');
const stmtInsertTaskMessage = db.prepare(`
  INSERT INTO task_messages (id, task_id, role, content, thinking, created_at)
  VALUES (@id, @task_id, @role, @content, @thinking, @created_at)
`);

export function getAllProjects(): Project[] {
  return stmtAllProjects.all() as Project[];
}

export function getProject(path: string): Project | undefined {
  return stmtGetProject.get(path) as Project | undefined;
}

export function saveProject(project: { path: string; label?: string | null }): Project {
  const now = Date.now();
  stmtInsertProject.run({
    path: project.path,
    label: project.label ?? null,
    created_at: getProject(project.path)?.created_at ?? now,
    updated_at: now,
  });
  return getProject(project.path) as Project;
}

export function deleteProject(path: string): { deleted: boolean; taskIds: string[] } {
  const taskIds = (stmtTaskIdsByWorkspacePath.all(path) as Array<{ id: string }>).map((row) => row.id);
  const result = db.transaction(() => {
    const deletedProject = stmtDeleteProject.run(path).changes > 0;
    if (taskIds.length > 0) stmtDeleteTasksByWorkspacePath.run(path);
    return deletedProject || taskIds.length > 0;
  })();
  return { deleted: result, taskIds };
}

export function getAllTasks(status?: TaskStatus): Task[] {
  return status ? stmtTasksByStatus.all(status) as Task[] : stmtAllTasks.all() as Task[];
}

export function getTask(id: string): Task | undefined {
  return stmtGetTask.get(id) as Task | undefined;
}

export function insertTask(task: {
  title: string;
  description?: string | null;
  status: TaskStatus;
  task_kind?: TaskKind | null;
  task_mode?: TaskMode | null;
  workspace_path?: string | null;
  agent_runtime?: AgentRuntime | null;
  agent_model?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  last_agent_response_at?: number | null;
}): Task {
  const id = uuid();
  const now = Date.now();
  const row = {
    id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    task_kind: task.task_kind ?? 'task',
    task_mode: task.task_mode ?? 'direct',
    workspace_path: task.workspace_path ?? null,
    agent_runtime: task.agent_runtime ?? null,
    agent_model: task.agent_model ?? null,
    reasoning_effort: task.reasoning_effort ?? null,
    created_at: now,
    updated_at: now,
    last_agent_response_at: task.last_agent_response_at ?? null,
    last_viewed_at: null,
    last_context_used_tokens: null,
    last_context_window_tokens: null,
  };
  stmtInsertTask.run(row);
  return row as Task;
}

const ALLOWED_UPDATE_FIELDS = new Set<string>([
  'title',
  'description',
  'status',
  'task_mode',
  'workspace_path',
  'agent_runtime',
  'agent_model',
  'reasoning_effort',
  'last_agent_response_at',
  'last_context_used_tokens',
  'last_context_window_tokens',
]);
const updateStmtCache = new Map<string, ReturnType<typeof db.prepare>>();

type TaskUpdateFields = Pick<
  Task,
  | 'title'
  | 'description'
  | 'status'
  | 'task_mode'
  | 'workspace_path'
  | 'agent_runtime'
  | 'agent_model'
  | 'reasoning_effort'
  | 'last_agent_response_at'
  | 'last_context_used_tokens'
  | 'last_context_window_tokens'
>;

function getUpdateStmt(fieldKeys: string[]): ReturnType<typeof db.prepare> {
  const key = fieldKeys.join(',');
  let stmt = updateStmtCache.get(key);
  if (!stmt) {
    const sets = fieldKeys.map(f => `${f} = @${f}`).join(', ');
    stmt = db.prepare(`UPDATE tasks SET ${sets}, updated_at = @updated_at WHERE id = @id`);
    updateStmtCache.set(key, stmt);
  }
  return stmt;
}

export function updateTask(
  id: string,
  fields: Partial<TaskUpdateFields>,
): Task | undefined {
  const fieldKeys: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_UPDATE_FIELDS.has(key)) continue;
    fieldKeys.push(key);
    values[key] = value ?? null;
  }

  if (fieldKeys.length === 0) return getTask(id);

  values.updated_at = Date.now();
  getUpdateStmt(fieldKeys).run(values);
  return getTask(id);
}

export function touchTask(id: string): void {
  stmtTouchTask.run(Date.now(), id);
}

export function contextFromTask(task: Task): ContextUsage | null {
  if (task.last_context_used_tokens == null || task.last_context_window_tokens == null) return null;
  return { used_tokens: task.last_context_used_tokens, window_tokens: task.last_context_window_tokens };
}

export function recordAgentResponse(taskId: string, at = Date.now(), context?: ContextUsage | null): Task | undefined {
  return updateTask(taskId, {
    last_agent_response_at: at,
    ...(context !== undefined ? {
      last_context_used_tokens: context?.used_tokens ?? null,
      last_context_window_tokens: context?.window_tokens ?? null,
    } : {}),
  });
}

export function markTaskViewed(id: string): { task: Task | undefined; changed: boolean } {
  const result = stmtMarkTaskViewed.run(id);
  return {
    task: getTask(id),
    changed: result.changes > 0,
  };
}

export function deleteTask(id: string): boolean {
  const result = stmtDeleteTask.run(id);
  return result.changes > 0;
}

export function getAppSetting(key: string): string | null {
  const row = stmtGetAppSetting.get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string | null): void {
  if (value === null) {
    stmtDeleteAppSetting.run(key);
    return;
  }
  stmtSetAppSetting.run(key, value);
}

export function getTaskMessages(taskId: string): TaskMessage[] {
  return stmtGetTaskMessages.all(taskId) as TaskMessage[];
}

export function appendTaskMessage(
  taskId: string,
  role: TaskMessage['role'],
  content: string,
  thinking?: string | null,
  createdAt = Date.now(),
): TaskMessage {
  const row: TaskMessage = {
    id: uuid(),
    task_id: taskId,
    role,
    content,
    thinking: thinking ?? undefined,
    created_at: createdAt,
  };
  stmtInsertTaskMessage.run({
    ...row,
    thinking: row.thinking ?? null,
  });
  return row;
}
