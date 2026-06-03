import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import {
  SquarePen,
  Columns3,
  Settings,
  PanelLeftClose,
  PanelLeft,
  CalendarClock,
  Sparkles,
  Folder,
  Folders,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquare,
  Plus,
  Inbox,
} from 'lucide-react';
import { useStore } from '../lib/store';
import { isEditableTarget } from '../lib/keyboard';
import { groupTasksByProject, normalizeProjectPath, projectHref } from '../lib/projects';
import { timeAgo, toErrorMessage } from '../lib/format';
import { isChatTask } from '../lib/taskState';
import { createProject, pickWorkspaceDirectory } from '../lib/api';

const isMac = /Mac/.test(navigator.userAgent);
const PROJECT_EXPANSION_STORAGE_KEY = 'sidebarExpandedProjects';

function readExpandedProjects(): string[] {
  try {
    const raw = localStorage.getItem(PROJECT_EXPANSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const streamingTaskIds = useStore((s) => s.streamingTaskIds);
  const rememberedProjectPath = useStore((s) => s.currentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);
  const projectGroups = useMemo(() => groupTasksByProject(tasks, streamingTaskIds, projects), [projects, tasks, streamingTaskIds]);
  const recentChats = useMemo(
    () => tasks.filter(isChatTask).sort((a, b) => b.updated_at - a.updated_at).slice(0, 6),
    [tasks],
  );
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(readExpandedProjects()));
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  const activeTask = useMemo(() => {
    const match = location.pathname.match(/^\/tasks\/([^/]+)$/);
    if (!match || location.pathname === '/tasks/new') return null;
    return tasks.find((task) => task.id === match[1]) ?? null;
  }, [location.pathname, tasks]);

  const currentProjectPath = useMemo(() => {
    if (location.pathname === '/projects') {
      return normalizeProjectPath(new URLSearchParams(location.search).get('path'));
    }
    if (location.pathname === '/tasks/new') {
      return normalizeProjectPath(new URLSearchParams(location.search).get('workspacePath')) ?? rememberedProjectPath;
    }
    return normalizeProjectPath(activeTask?.workspace_path) ?? rememberedProjectPath;
  }, [activeTask?.workspace_path, location.pathname, location.search, rememberedProjectPath]);

  const newTaskPath = currentProjectPath
    ? `/tasks/new?workspacePath=${encodeURIComponent(currentProjectPath)}`
    : '/tasks/new';

  useEffect(() => {
    let chordKey: string | null = null;
    let chordTimeout: ReturnType<typeof setTimeout> | null = null;

    function handleKeyDown(e: KeyboardEvent) {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        navigate(newTaskPath);
        return;
      }

      if (isEditableTarget(e) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;

      const key = e.key.toLowerCase();

      if (chordKey === 'g') {
        chordKey = null;
        if (chordTimeout) clearTimeout(chordTimeout);
        const routes: Record<string, string> = { t: '/', c: '/chats', p: '/projects', f: '/files', a: '/activity' };
        if (routes[key]) {
          e.preventDefault();
          navigate(routes[key]);
        }
        return;
      }

      if (key === 'g') {
        chordKey = 'g';
        if (chordTimeout) clearTimeout(chordTimeout);
        chordTimeout = setTimeout(() => {
          chordKey = null;
        }, 500);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (chordTimeout) clearTimeout(chordTimeout);
    };
  }, [navigate, newTaskPath]);

  useEffect(() => {
    if (!currentProjectPath) return;
    setExpandedProjects((current) => {
      if (current.has(currentProjectPath)) return current;
      const next = new Set(current);
      next.add(currentProjectPath);
      localStorage.setItem(PROJECT_EXPANSION_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, [currentProjectPath]);

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/' || (location.pathname.startsWith('/tasks/') && location.pathname !== '/tasks/new');
    if (path === '/chats') return location.pathname === '/chats' || location.pathname.startsWith('/chats/');
    if (path === '/projects') return location.pathname === '/projects';
    return location.pathname === path;
  };

  const toggleProject = (key: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem(PROJECT_EXPANSION_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const handleNewProject = async () => {
    if (isCreatingProject) return;
    setIsCreatingProject(true);
    setProjectError(null);
    try {
      const picked = await pickWorkspaceDirectory(null);
      if (!picked.path) return;
      const result = await createProject(picked.path);
      upsertProject(result.project);
      navigate(projectHref(result.project.path));
    } catch (error) {
      setProjectError(toErrorMessage(error, 'Failed to create project'));
    } finally {
      setIsCreatingProject(false);
    }
  };

  return (
    <aside
      className={`shrink-0 bg-sidebar dark:bg-zinc-950 flex flex-col transition-[width] duration-200 ease-in-out overflow-hidden ${
        collapsed ? 'w-16' : 'w-72'
      }`}
    >
      <div className="flex items-center justify-center py-4 px-2">
        {collapsed ? (
          <button
            onClick={toggleSidebar}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors p-1.5 rounded-lg hover:bg-surface dark:hover:bg-zinc-800"
            title="Expand sidebar"
          >
            <PanelLeft size={20} />
          </button>
        ) : (
          <div className="flex items-center justify-between w-full px-2">
            <button onClick={() => navigate('/')} className="flex h-9 w-28 shrink-0 items-center" title="Home">
              <img src="/logo.png" alt="OneInfer" className="h-9 w-full object-contain object-left" />
            </button>
            <button
              onClick={toggleSidebar}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors p-1.5 rounded-lg hover:bg-surface dark:hover:bg-zinc-800"
              title="Collapse sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pb-4">
        <nav className={`space-y-1 ${collapsed ? 'px-2' : 'px-3'}`}>
          <SidebarLink
            icon={<SquarePen size={18} />}
            label="New Task"
            to={newTaskPath}
            active={isActive('/tasks/new')}
            collapsed={collapsed}
            shortcut={isMac ? 'Shift+Cmd+O' : 'Ctrl+Shift+O'}
          />
          <SidebarLink
            icon={<MessageSquare size={18} />}
            label="New Chat"
            to="/chats"
            active={isActive('/chats')}
            collapsed={collapsed}
            shortcut={['G', 'C']}
          />
          <SidebarLink
            icon={<Columns3 size={18} />}
            label="Tasks"
            to="/"
            active={isActive('/')}
            collapsed={collapsed}
            shortcut={['G', 'T']}
          />
          <SidebarLink
            icon={<Folders size={18} />}
            label="Projects"
            to="/projects"
            active={isActive('/projects')}
            collapsed={collapsed}
            shortcut={['G', 'P']}
          />
          <SidebarLink
            icon={<Inbox size={18} />}
            label="Activity"
            to="/activity"
            active={isActive('/activity')}
            collapsed={collapsed}
            shortcut={['G', 'A']}
          />
          <SidebarLink
            icon={<Folder size={18} />}
            label="Files"
            to="/files"
            active={isActive('/files')}
            collapsed={collapsed}
            shortcut={['G', 'F']}
          />
          <SidebarLink
            icon={<CalendarClock size={18} />}
            label="Schedules"
            to="/cron"
            active={isActive('/cron')}
            collapsed={collapsed}
          />
          <SidebarLink
            icon={<Sparkles size={18} />}
            label="Skills"
            to="/skills"
            active={isActive('/skills')}
            collapsed={collapsed}
          />
          <SidebarLink
            icon={<Settings size={18} />}
            label="Settings"
            to="/settings"
            active={isActive('/settings')}
            collapsed={collapsed}
          />
        </nav>

        {!collapsed && (
          <div className="mt-5 px-3 space-y-5">
            {recentChats.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between px-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-500">
                    Recent Chats
                  </span>
                  <span className="rounded-full bg-zinc-200/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                    {recentChats.length}
                  </span>
                </div>
                <div className="overflow-hidden rounded-2xl border border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                  {recentChats.map((chat, index) => {
                    const isChatActive = location.pathname === `/chats/${chat.id}`;
                    const isStreaming = streamingTaskIds.has(chat.id);

                    return (
                      <Link
                        key={chat.id}
                        to={`/chats/${chat.id}`}
                        className={`block px-3 py-2.5 transition-colors ${
                          index !== 0 ? 'border-t border-zinc-100 dark:border-zinc-900' : ''
                        } ${
                          isChatActive
                            ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100'
                            : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/70'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {isStreaming ? (
                            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-zinc-400" />
                          ) : (
                            <MessageSquare size={13} className="mt-0.5 shrink-0 text-zinc-400" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{chat.title}</div>
                            <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                              {isStreaming ? 'Working...' : timeAgo(chat.updated_at)}
                            </div>
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
            <div className="mb-2 flex items-center justify-between px-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400 dark:text-zinc-500">
                Projects
              </span>
              <div className="flex items-center gap-1">
                <span className="rounded-full bg-zinc-200/70 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  {projectGroups.length}
                </span>
                <button
                  type="button"
                  onClick={handleNewProject}
                  disabled={isCreatingProject}
                  title="New project"
                  aria-label="New project"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-200/80 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  {isCreatingProject ? <Loader2 size={13} className="animate-spin" /> : <Plus size={14} />}
                </button>
              </div>
            </div>
            {projectError && (
              <p className="mb-2 px-2 text-xs text-red-500 dark:text-red-400">{projectError}</p>
            )}
            {projectGroups.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-200 bg-white/60 px-3 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                Create a project and it will show up here.
              </div>
            ) : (
              <div className="space-y-2">
                {projectGroups.map((project) => {
                  const expanded = expandedProjects.has(project.key);
                  const isProjectActive = currentProjectPath === project.path;

                  return (
                    <section
                      key={project.key}
                      className={`rounded-2xl border transition-colors ${
                        isProjectActive
                          ? 'border-zinc-300 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-900'
                          : 'border-transparent bg-zinc-100/60 dark:bg-zinc-900/50'
                      }`}
                    >
                      <div className="flex items-center gap-1 p-1.5">
                        <Link
                          to={projectHref(project.path)}
                          className={`min-w-0 flex-1 rounded-xl px-2.5 py-2 transition-colors ${
                            isProjectActive
                              ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                              : 'text-zinc-700 hover:bg-white/80 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <Folder size={15} className="shrink-0 text-zinc-500 dark:text-zinc-400" />
                            <span className="truncate text-sm font-medium">{project.label}</span>
                            {project.streamingCount > 0 && (
                              <Loader2 size={13} className="ml-auto shrink-0 animate-spin text-zinc-400" />
                            )}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                            <span>{project.taskCount} task{project.taskCount === 1 ? '' : 's'}</span>
                            <span>|</span>
                            <span>{timeAgo(project.updatedAt)}</span>
                          </div>
                        </Link>
                        <button
                          type="button"
                          onClick={() => toggleProject(project.key)}
                          aria-label={expanded ? `Collapse ${project.label}` : `Expand ${project.label}`}
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-white hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                        >
                          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        </button>
                      </div>
                      {expanded && (
                        <div className="px-2 pb-2">
                          <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white dark:border-zinc-800 dark:bg-zinc-950">
                            {project.tasks.length === 0 ? (
                              <div className="px-3 py-3 text-xs text-zinc-400 dark:text-zinc-500">
                                No tasks yet
                              </div>
                            ) : project.tasks.map((task, index) => {
                              const isTaskActive = location.pathname === `/tasks/${task.id}`;
                              const isStreaming = streamingTaskIds.has(task.id);

                              return (
                                <Link
                                  key={task.id}
                                  to={`/tasks/${task.id}`}
                                  className={`block px-3 py-2.5 transition-colors ${
                                    index !== 0 ? 'border-t border-zinc-100 dark:border-zinc-900' : ''
                                  } ${
                                    isTaskActive
                                      ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100'
                                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/70'
                                  }`}
                                >
                                  <div className="flex items-start gap-2">
                                    <span className={`mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full ${isStreaming ? 'bg-amber-500' : 'bg-zinc-300 dark:bg-zinc-700'}`} />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-medium">{task.title}</div>
                                      <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500">
                                        <span>{timeAgo(task.updated_at)}</span>
                                        <span>|</span>
                                        <span>{task.status.replace('_', ' ')}</span>
                                      </div>
                                    </div>
                                  </div>
                                </Link>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function SidebarLink({
  icon,
  label,
  to,
  active,
  collapsed,
  shortcut,
}: {
  icon: React.ReactNode;
  label: string;
  to: string;
  active: boolean;
  collapsed: boolean;
  shortcut?: string | string[];
}) {
  return (
    <Link
      to={to}
      title={collapsed ? (shortcut ? `${label} (${Array.isArray(shortcut) ? shortcut.join(' then ') : shortcut})` : label) : undefined}
      className={`group w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
        active
          ? 'bg-surface dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm'
          : 'text-zinc-700 dark:text-zinc-300 hover:bg-surface dark:hover:bg-zinc-800'
      }`}
    >
      <span className={active ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'}>
        {icon}
      </span>
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && shortcut && (
        Array.isArray(shortcut) ? (
          <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Kbd>{shortcut[0]}</Kbd>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">then</span>
            <Kbd>{shortcut[1]}</Kbd>
          </span>
        ) : (
          <span className="ml-auto text-xs text-zinc-400 dark:text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity tracking-widest">
            {shortcut}
          </span>
        )
      )}
    </Link>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="text-[11px] font-medium leading-none px-1.5 py-0.5 rounded border border-zinc-300/60 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
      {children}
    </kbd>
  );
}
