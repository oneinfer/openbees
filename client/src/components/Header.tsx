import { Link, useMatch, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { useStore } from '../lib/store';

export function Header() {
  const location = useLocation();
  const match = useMatch('/tasks/:taskId');
  const taskId = match?.params.taskId;
  const task = useStore((s) => taskId ? s.tasks.find((t) => t.id === taskId) : null);

  const isSettings = location.pathname === '/settings';
  const isNewTask = location.pathname === '/tasks/new';
  const isCron = location.pathname === '/cron';
  const isSkills = location.pathname === '/skills';
  const isFiles = location.pathname === '/files';

  let title = 'Tasks';
  let showParent = false;
  let truncate = false;

  if (isSettings) {
    title = 'Settings';
  } else if (isCron) {
    title = 'Schedules';
  } else if (isSkills) {
    title = 'Skills';
  } else if (isFiles) {
    title = 'Files';
  } else if (isNewTask) {
    title = 'New Task';
    showParent = true;
  } else if (task) {
    title = task.title;
    showParent = true;
    truncate = true;
  }

  return (
    <header className="flex items-center px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-surface dark:bg-zinc-950">
      <div className="flex items-center gap-2 min-w-0">
        {showParent && (
          <>
            <Link to="/" className="text-sm font-medium text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors shrink-0">
              Tasks
            </Link>
            <ChevronRight size={14} className="text-zinc-300 dark:text-zinc-600 shrink-0" />
          </>
        )}
        <span className={`text-sm font-medium text-zinc-900 dark:text-zinc-100${truncate ? ' truncate' : ''}`}>
          {title}
        </span>
      </div>
    </header>
  );
}
