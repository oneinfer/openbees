import { TASK_STATUSES, type Project, type Task, type TaskStatus } from '@shared/types';

const NO_PROJECT_KEY = '__no_project__';

export interface ProjectGroup {
  key: string;
  path: string | null;
  label: string;
  taskCount: number;
  updatedAt: number;
  streamingCount: number;
  statusCounts: Record<TaskStatus, number>;
  tasks: Task[];
  project?: Project;
}

export function getProjectLabel(path: string | null | undefined): string {
  const normalized = normalizeProjectPath(path);
  if (!normalized) return 'No Project';

  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const label = parts[parts.length - 1];
  return label && label.trim().length > 0 ? label : normalized;
}

export function normalizeProjectPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function projectHref(path: string | null | undefined): string {
  const normalized = normalizeProjectPath(path);
  return normalized ? `/projects?path=${encodeURIComponent(normalized)}` : '/projects';
}

function emptyStatusCounts(): Record<TaskStatus, number> {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
}

export function groupTasksByProject(tasks: Task[], streamingTaskIds?: ReadonlySet<string>, projects: Project[] = []): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();

  for (const project of projects) {
    const path = normalizeProjectPath(project.path);
    if (!path) continue;
    groups.set(path, {
      key: path,
      path,
      label: project.label?.trim() || getProjectLabel(path),
      taskCount: 0,
      updatedAt: project.updated_at,
      streamingCount: 0,
      statusCounts: emptyStatusCounts(),
      tasks: [],
      project,
    });
  }

  for (const task of tasks) {
    const path = normalizeProjectPath(task.workspace_path);
    const key = path ?? NO_PROJECT_KEY;
    const existing = groups.get(key);

    if (existing) {
      existing.tasks.push(task);
      existing.taskCount += 1;
      existing.updatedAt = Math.max(existing.updatedAt, task.updated_at);
      existing.statusCounts[task.status] += 1;
      if (streamingTaskIds?.has(task.id)) existing.streamingCount += 1;
      continue;
    }

    const statusCounts = emptyStatusCounts();
    statusCounts[task.status] = 1;

    groups.set(key, {
      key,
      path,
      label: getProjectLabel(path),
      taskCount: 1,
      updatedAt: task.updated_at,
      streamingCount: streamingTaskIds?.has(task.id) ? 1 : 0,
      statusCounts,
      tasks: [task],
    });
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      tasks: [...group.tasks].sort((a, b) => b.updated_at - a.updated_at),
    }))
    .sort((a, b) => {
      if (a.path === null && b.path !== null) return 1;
      if (a.path !== null && b.path === null) return -1;
      return b.updatedAt - a.updatedAt;
    });
}

export function findProjectByPath(
  tasks: Task[],
  path: string | null | undefined,
  streamingTaskIds?: ReadonlySet<string>,
  projects?: Project[],
) {
  const normalized = normalizeProjectPath(path);
  return groupTasksByProject(tasks, streamingTaskIds, projects).find((group) => group.path === normalized) ?? null;
}
