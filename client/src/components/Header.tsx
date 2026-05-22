import { Link, useMatch, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useStore } from '../lib/store';
import { getProjectLabel, projectHref } from '../lib/projects';

export function Header() {
  const location = useLocation();
  const match = useMatch('/tasks/:taskId');
  const chatMatch = useMatch('/chats/:chatId');
  const taskId = match?.params.taskId;
  const chatId = chatMatch?.params.chatId;
  const task = useStore((s) => taskId ? s.tasks.find((t) => t.id === taskId) : null);
  const chat = useStore((s) => chatId ? s.tasks.find((t) => t.id === chatId) : null);
  const projectPath = new URLSearchParams(location.search).get('path');
  const selectedProjectLabel = getProjectLabel(projectPath);

  const isSettings = location.pathname === '/settings';
  const isNewTask = location.pathname === '/tasks/new';
  const isChats = location.pathname === '/chats' || location.pathname.startsWith('/chats/');
  const isCron = location.pathname === '/cron';
  const isSkills = location.pathname === '/skills';
  const isFiles = location.pathname === '/files';
  const isProjects = location.pathname === '/projects';

  let title = 'Tasks';
  let breadcrumb: { label: string; to?: string }[] = [];
  let truncate = false;

  if (isChats) {
    title = chat?.title ?? 'New Chat';
    breadcrumb = chat ? [{ label: 'Chats', to: '/chats' }] : [];
    truncate = true;
  } else if (isSettings) {
    title = 'Settings';
  } else if (isCron) {
    title = 'Schedules';
  } else if (isSkills) {
    title = 'Skills';
  } else if (isFiles) {
    title = 'Files';
  } else if (isProjects) {
    title = projectPath ? selectedProjectLabel : 'Projects';
    if (projectPath) breadcrumb = [{ label: 'Projects', to: '/projects' }];
  } else if (isNewTask) {
    title = 'New Task';
    breadcrumb = [{ label: 'Tasks', to: '/' }];
  } else if (task) {
    title = task.title;
    breadcrumb = task.workspace_path
      ? [
          { label: 'Projects', to: '/projects' },
          { label: getProjectLabel(task.workspace_path), to: projectHref(task.workspace_path) },
        ]
      : [{ label: 'Tasks', to: '/' }];
    truncate = true;
  }

  return (
    <header className="flex items-center px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-surface dark:bg-zinc-950">
      <div className="flex items-center gap-2 min-w-0">
        {breadcrumb.map((item) => (
          <div key={`${item.label}:${item.to ?? 'current'}`} className="flex items-center gap-2 shrink-0">
            {item.to ? (
              <Link to={item.to} className="text-sm font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors">
                {item.label}
              </Link>
            ) : (
              <span className="text-sm font-medium text-zinc-400 dark:text-zinc-500">
                {item.label}
              </span>
            )}
            <ChevronRight size={14} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
          </div>
        ))}
        <span className={`text-sm font-medium text-zinc-900 dark:text-zinc-100${truncate ? ' truncate' : ''}`}>
          {title}
        </span>
      </div>
    </header>
  );
}
