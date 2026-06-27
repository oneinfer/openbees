import { Link, useMatch, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, LogOut } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useOrganizations } from '../auth/OrganizationContext';
import { useStore } from '../lib/store';
import { getProjectLabel, projectHref } from '../lib/projects';

export function Header() {
  const { developer, logout, status: authStatus } = useAuth();
  const {
    activeWorkspace,
    organizations,
    selectOrganization,
    selectPersonalWorkspace,
  } = useOrganizations();
  const navigate = useNavigate();
  const handleLogout = () => {
    navigate('/tasks/new', { replace: true });
    logout();
  };
  const location = useLocation();
  const match = useMatch('/tasks/:taskId');
  const taskId = match?.params.taskId;
  const task = useStore((s) => taskId ? s.tasks.find((t) => t.id === taskId) : null);
  const projectPath = new URLSearchParams(location.search).get('path');
  const selectedProjectLabel = getProjectLabel(projectPath);
  const isAuthenticated = authStatus === 'authenticated';

  const handleWorkspaceChange = (value: string) => {
    if (value === 'personal') selectPersonalWorkspace();
    else selectOrganization(value);
    navigate('/', { replace: false });
  };

  const isSettings = location.pathname === '/settings';
  const isNewTask = location.pathname === '/tasks/new';
  const isCron = location.pathname === '/cron';
  const isSkills = location.pathname === '/skills';
  const isFiles = location.pathname === '/files';
  const isProjects = location.pathname === '/projects';
  const isOrganization = location.pathname === '/organization';

  let title = 'Tasks';
  let breadcrumb: { label: string; to?: string }[] = [];
  let truncate = false;

  if (isSettings) {
    title = 'Settings';
  } else if (isOrganization) {
    title = 'Organization';
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
    <header className="flex items-center justify-between gap-4 px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-surface dark:bg-zinc-950">
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
      <div className="flex shrink-0 items-center gap-3">
        {isAuthenticated && (
          <>
            <label>
              <span className="sr-only">Active workspace</span>
              <select
                value={activeWorkspace.type === 'personal' ? 'personal' : activeWorkspace.organizationId}
                onChange={(event) => handleWorkspaceChange(event.target.value)}
                className="h-8 min-w-36 max-w-52 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-700 shadow-sm outline-none transition-colors hover:bg-zinc-50 focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                aria-label="Active workspace"
              >
                <option value="personal">Personal</option>
                {organizations.map((organization) => (
                  <option key={organization.organization_id} value={organization.organization_id}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
            {developer?.email && (
              <span className="hidden max-w-48 truncate text-xs font-medium text-zinc-500 dark:text-zinc-400 sm:block">
                {developer.email}
              </span>
            )}
            <button
              type="button"
              onClick={handleLogout}
              title="Sign out"
              aria-label="Sign out"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <LogOut size={16} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
