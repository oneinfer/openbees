import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Folder, FolderOpen, Loader2, ArrowUpRight, Sparkles } from 'lucide-react';
import { TASK_STATUSES, type Task } from '@shared/types';
import { useStore } from '../lib/store';
import { STATUS_META } from '../lib/constants';
import { getProjectLabel, groupTasksByProject, normalizeProjectPath, projectHref } from '../lib/projects';
import { timeAgo } from '../lib/format';

function TaskListItem({ task, isStreaming }: { task: Task; isStreaming: boolean }) {
  return (
    <Link
      to={`/tasks/${task.id}`}
      className="group flex items-start justify-between gap-4 rounded-2xl border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/70"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${isStreaming ? 'bg-amber-500' : 'bg-zinc-300 dark:bg-zinc-700'}`} />
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{task.title}</p>
        </div>
        {task.description && (
          <p className="mt-1 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">
            {task.description}
          </p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${STATUS_META[task.status].tint}`}>
          {STATUS_META[task.status].label}
        </span>
        <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
          {isStreaming ? 'Working...' : timeAgo(task.updated_at)}
        </p>
      </div>
    </Link>
  );
}

export function ProjectsPage() {
  const [searchParams] = useSearchParams();
  const tasks = useStore((s) => s.tasks);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const streamingTaskIds = useStore((s) => s.streamingTaskIds);
  const requestedProjectPath = normalizeProjectPath(searchParams.get('path'));
  const projectGroups = useMemo(() => groupTasksByProject(tasks, streamingTaskIds), [tasks, streamingTaskIds]);
  const selectedProject = requestedProjectPath
    ? projectGroups.find((project) => project.path === requestedProjectPath) ?? null
    : null;

  if (!tasksLoaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-zinc-400" />
      </div>
    );
  }

  if (requestedProjectPath && !selectedProject) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-md rounded-3xl border border-dashed border-zinc-300 bg-white px-6 py-8 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <FolderOpen size={28} className="mx-auto text-zinc-400" />
          <p className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Project not found</p>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            The selected folder does not have any tasks yet.
          </p>
          <Link
            to="/projects"
            className="mt-5 inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <ArrowUpRight size={14} />
            Browse all projects
          </Link>
        </div>
      </div>
    );
  }

  if (!requestedProjectPath) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-zinc-400 dark:text-zinc-500">Projects</p>
              <h1 className="mt-1 text-3xl font-semibold text-zinc-900 dark:text-zinc-100">
                Browse work by repository
              </h1>
            </div>
            <Link
              to="/tasks/new"
              className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              <Sparkles size={15} />
              New task
            </Link>
          </div>

          {projectGroups.length === 0 ? (
            <div className="mt-8 rounded-3xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-900">
              <FolderOpen size={28} className="mx-auto text-zinc-400" />
              <p className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">No projects yet</p>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                Choose a working folder when you create a task and it will appear here automatically.
              </p>
            </div>
          ) : (
            <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {projectGroups.map((project) => (
                <Link
                  key={project.key}
                  to={projectHref(project.path)}
                  className="group rounded-3xl border border-zinc-200 bg-white p-5 transition-colors hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/70"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Folder size={16} className="shrink-0 text-zinc-500 dark:text-zinc-400" />
                        <h2 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                          {project.label}
                        </h2>
                      </div>
                      {project.path && (
                        <p className="mt-2 line-clamp-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                          {project.path}
                        </p>
                      )}
                    </div>
                    <ArrowUpRight size={16} className="shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-300" />
                  </div>
                  <div className="mt-5 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span>{project.taskCount} task{project.taskCount === 1 ? '' : 's'}</span>
                    <span>|</span>
                    <span>{timeAgo(project.updatedAt)}</span>
                    {project.streamingCount > 0 && (
                      <>
                        <span>|</span>
                        <span>{project.streamingCount} active</span>
                      </>
                    )}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {TASK_STATUSES.map((status) => (
                      project.statusCounts[status] > 0 ? (
                        <span key={status} className={`inline-flex rounded-full px-2 py-1 text-[11px] font-medium ${STATUS_META[status].tint}`}>
                          {project.statusCounts[status]} {STATUS_META[status].label}
                        </span>
                      ) : null
                    ))}
                  </div>
                  <div className="mt-5 space-y-2">
                    {project.tasks.slice(0, 3).map((task) => (
                      <div key={task.id} className="rounded-2xl bg-zinc-50 px-3 py-2 dark:bg-zinc-950">
                        <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{task.title}</p>
                        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{timeAgo(task.updated_at)}</p>
                      </div>
                    ))}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col gap-4 rounded-[28px] border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm text-zinc-400 dark:text-zinc-500">
                <Folder size={15} />
                <span>Project</span>
              </div>
              <h1 className="mt-2 text-3xl font-semibold text-zinc-900 dark:text-zinc-100">
                {getProjectLabel(selectedProject?.path)}
              </h1>
              {selectedProject?.path && (
                <p className="mt-3 break-all font-mono text-sm text-zinc-500 dark:text-zinc-400">
                  {selectedProject.path}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedProject?.path && (
                <>
                  <Link
                    to={`/tasks/new?workspacePath=${encodeURIComponent(selectedProject.path)}`}
                    className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    <Sparkles size={15} />
                    New task in project
                  </Link>
                  <Link
                    to={`/files?path=${encodeURIComponent(selectedProject.path)}`}
                    className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
                  >
                    <FolderOpen size={15} />
                    Open files
                  </Link>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {TASK_STATUSES.map((status) => (
              selectedProject && selectedProject.statusCounts[status] > 0 ? (
                <span key={status} className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_META[status].tint}`}>
                  {selectedProject.statusCounts[status]} {STATUS_META[status].label}
                </span>
              ) : null
            ))}
          </div>
        </div>

        <div className="mt-8 space-y-8">
          {TASK_STATUSES.map((status) => {
            const tasksForStatus = selectedProject?.tasks.filter((task) => task.status === status) ?? [];
            if (tasksForStatus.length === 0) return null;

            return (
              <section key={status}>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-500">
                    {STATUS_META[status].label}
                  </h2>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">{tasksForStatus.length}</span>
                </div>
                <div className="space-y-3">
                  {tasksForStatus.map((task) => (
                    <TaskListItem
                      key={task.id}
                      task={task}
                      isStreaming={streamingTaskIds.has(task.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
