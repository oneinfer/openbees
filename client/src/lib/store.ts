import { create } from 'zustand';
import type { Project, Task, TaskStatus } from '@shared/types';

interface AppState {
  projects: Project[];
  tasks: Task[];
  streamingTaskIds: Set<string>;
  projectsLoaded: boolean;
  tasksLoaded: boolean;
  currentProjectPath: string | null;
  currentProjectLoaded: boolean;
  sidebarCollapsed: boolean;

  setProjects: (projects: Project[]) => void;
  upsertProject: (project: Project) => void;
  removeProject: (path: string, taskIds?: string[]) => void;
  setCurrentProjectPath: (path: string | null) => void;
  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setStreamingTasks: (ids: string[]) => void;
  setTaskStreaming: (taskId: string, streaming: boolean) => void;
  toggleSidebar: () => void;
}

function tasksEqual(a: Task, b: Task): boolean {
  return a.updated_at === b.updated_at && a.last_viewed_at === b.last_viewed_at;
}

const CURRENT_PROJECT_STORAGE_KEY = 'bees:lastWorkspacePath';

function normalizeStoredPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  return trimmed ? trimmed : null;
}

export const useStore = create<AppState>((set) => ({
  projects: [],
  tasks: [],
  streamingTaskIds: new Set<string>(),
  projectsLoaded: false,
  tasksLoaded: false,
  currentProjectPath: normalizeStoredPath(localStorage.getItem(CURRENT_PROJECT_STORAGE_KEY)),
  currentProjectLoaded: false,
  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',

  setProjects: (projects) => set({ projects, projectsLoaded: true }),

  upsertProject: (project) =>
    set((state) => {
      const idx = state.projects.findIndex((p) => p.path === project.path);
      if (idx === -1) return { projects: [project, ...state.projects] };
      const existing = state.projects[idx];
      if (existing.updated_at === project.updated_at && existing.label === project.label) return state;
      const next = [...state.projects];
      next[idx] = project;
      return { projects: next };
    }),

  removeProject: (path, taskIds = []) =>
    set((state) => {
      const taskIdSet = new Set(taskIds);
      const projects = state.projects.filter((project) => project.path !== path);
      const tasks = state.tasks.filter((task) => task.workspace_path !== path && !taskIdSet.has(task.id));
      const streamingTaskIds = new Set(state.streamingTaskIds);
      for (const taskId of taskIds) streamingTaskIds.delete(taskId);
      const clearCurrent = state.currentProjectPath === path;
      if (clearCurrent) localStorage.removeItem(CURRENT_PROJECT_STORAGE_KEY);
      return {
        projects,
        tasks,
        streamingTaskIds,
        ...(clearCurrent ? { currentProjectPath: null } : {}),
      };
    }),

  setCurrentProjectPath: (path) => {
    const normalized = normalizeStoredPath(path);
    if (normalized) localStorage.setItem(CURRENT_PROJECT_STORAGE_KEY, normalized);
    else localStorage.removeItem(CURRENT_PROJECT_STORAGE_KEY);
    set({ currentProjectPath: normalized, currentProjectLoaded: true });
  },

  setTasks: (tasks) => set({ tasks, tasksLoaded: true }),

  upsertTask: (task) =>
    set((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [...state.tasks, task] };
      const existing = state.tasks[idx];
      if (tasksEqual(existing, task)) return state;
      const next = [...state.tasks];
      next[idx] = task;
      return { tasks: next };
    }),

  removeTask: (taskId) =>
    set((state) => {
      const tasks = state.tasks.filter((t) => t.id !== taskId);
      if (!state.streamingTaskIds.has(taskId)) return { tasks };
      const next = new Set(state.streamingTaskIds);
      next.delete(taskId);
      return { tasks, streamingTaskIds: next };
    }),

  setStreamingTasks: (ids) =>
    set((state) => {
      if (ids.length === state.streamingTaskIds.size && ids.every((id) => state.streamingTaskIds.has(id))) {
        return state;
      }
      return { streamingTaskIds: new Set(ids) };
    }),

  setTaskStreaming: (taskId, streaming) =>
    set((state) => {
      if (streaming === state.streamingTaskIds.has(taskId)) return state;
      const next = new Set(state.streamingTaskIds);
      if (streaming) next.add(taskId);
      else next.delete(taskId);
      return { streamingTaskIds: next };
    }),

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      localStorage.setItem('sidebarCollapsed', String(next));
      return { sidebarCollapsed: next };
    }),
}));

export async function optimisticMoveTask(
  task: Task,
  status: TaskStatus,
  upsertTask: (t: Task) => void,
  apiMove: (id: string, s: TaskStatus) => Promise<{ task: Task }>,
) {
  upsertTask({ ...task, status, updated_at: Date.now() });
  try {
    const res = await apiMove(task.id, status);
    upsertTask(res.task);
  } catch {
    upsertTask(task);
  }
}
