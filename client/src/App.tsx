import { useEffect, useMemo, useRef, Component, type ReactNode, type ErrorInfo } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { OrganizationProvider, useOrganizations } from './auth/OrganizationContext';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Board } from './components/Board';
import { NewTaskPage } from './components/NewTaskPage';
import { TaskDetailPage } from './components/TaskDetailPage';
import { SettingsPage } from './components/SettingsPage';
import { CronPage } from './components/CronPage';
import { SkillsPage } from './components/SkillsPage';
import { FileBrowserPage } from './components/FileBrowserPage';
import { ProjectsPage } from './components/ProjectsPage';
import { OrganizationGate } from './components/OrganizationGate';
import { OrganizationPage } from './components/OrganizationPage';
import { AuthCallbackPage } from './components/AuthCallbackPage';
import { TaskCreatedToast } from './components/TaskCreatedToast';
import { useActivityCapture } from './hooks/useActivityCapture';
import { useTasks } from './hooks/useTasks';
import { useTheme } from './hooks/useTheme';
import { updateCurrentProject } from './lib/api';
import { useStore } from './lib/store';
import { normalizeProjectPath } from './lib/projects';

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('App render error:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950 p-8 text-center">
          <p className="text-base font-semibold text-red-400">Something went wrong</p>
          <pre className="max-w-lg overflow-auto rounded-lg bg-zinc-900 p-4 text-left text-xs text-zinc-300">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => { this.setState({ error: null }); window.location.href = '/'; }}
            className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Go to home
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm font-medium text-zinc-400">
      Loading...
    </div>
  );
}

function OrganizationRoute() {
  const { status } = useAuth();
  const {
    status: organizationStatus,
    organizations,
    selectedOrganization,
    selectOrganization,
  } = useOrganizations();
  const wasAuthenticatedRef = useRef(false);

  if (status === 'authenticated') {
    wasAuthenticatedRef.current = true;
  }

  useEffect(() => {
    if (
      status === 'authenticated'
      && organizationStatus === 'ready'
      && !selectedOrganization
      && organizations[0]
    ) {
      selectOrganization(organizations[0].organization_id);
    }
  }, [organizationStatus, organizations, selectOrganization, selectedOrganization, status]);

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'unauthenticated') {
    // After logout (was authenticated this session) → stay in app at new task page.
    // Fresh visit with no session → redirect to enterprise login.
    return wasAuthenticatedRef.current
      ? <Navigate to="/tasks/new" replace />
      : <EnterpriseLoginRedirect />;
  }
  if (organizationStatus === 'loading' || organizationStatus === 'idle') return <LoadingScreen />;
  if (organizationStatus === 'error') return <OrganizationGate mode="error" />;
  if (organizations.length === 0) return <OrganizationGate mode="create" />;
  if (!selectedOrganization) return <LoadingScreen />;

  return <OrganizationPage />;
}

function EnterpriseLoginRedirect() {
  useEffect(() => {
    const enterpriseAppUrl = import.meta.env.VITE_OPENBEES_ENTERPRISE_APP_URL?.trim()
      || 'http://localhost:3000';
    const loginUrl = new URL('/login', enterpriseAppUrl);
    loginUrl.searchParams.set('return_to', `${window.location.origin}/auth/callback`);
    loginUrl.searchParams.set('next', '/organization');
    window.location.replace(loginUrl.toString());
  }, []);

  return <LoadingScreen />;
}

function AppShell() {
  useTasks();
  useTheme();
  useActivityCapture();
  useRememberCurrentProject();
  useStartupProjectRedirect();

  return (
    <div className="h-screen flex overflow-hidden bg-sidebar dark:bg-zinc-950">
      <Sidebar />
      <main className="m-2 ml-0 flex-1 flex flex-col min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-surface shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <Header />
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/organization" element={<OrganizationRoute />} />
          <Route path="/activity" element={<Navigate to="/" replace />} />
          <Route path="/chats/*" element={<Navigate to="/" replace />} />
          <Route path="/tasks/new" element={<NewTaskPage />} />
          <Route path="/tasks" element={<Navigate to="/" replace />} />
          <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="/cron" element={<CronPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/files" element={<FileBrowserPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <TaskCreatedToast />
    </div>
  );
}

function useStartupProjectRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const currentProjectLoaded = useStore((s) => s.currentProjectLoaded);
  const attemptedRedirect = useRef(false);

  useEffect(() => {
    if (attemptedRedirect.current || !currentProjectLoaded) return;
    attemptedRedirect.current = true;
    if (location.pathname === '/' && currentProjectPath) {
      navigate('/tasks/new', { replace: true });
    }
  }, [currentProjectLoaded, currentProjectPath, location.pathname, navigate]);
}

function useRememberCurrentProject() {
  const location = useLocation();
  const tasks = useStore((s) => s.tasks);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);

  const routeProjectPath = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const taskMatch = location.pathname.match(/^\/tasks\/([^/]+)$/);

    if (location.pathname === '/projects') return normalizeProjectPath(params.get('path'));
    if (taskMatch) return normalizeProjectPath(tasks.find((task) => task.id === taskMatch[1])?.workspace_path);
    return null;
  }, [location.pathname, location.search, tasks]);

  useEffect(() => {
    if (!routeProjectPath || routeProjectPath === currentProjectPath) return;

    setCurrentProjectPath(routeProjectPath);
    updateCurrentProject(routeProjectPath)
      .then((result) => {
        if (result.project) upsertProject(result.project);
      })
      .catch(console.error);
  }, [currentProjectPath, routeProjectPath, setCurrentProjectPath, upsertProject]);
}

export default function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <OrganizationProvider>
            <Routes>
              <Route path="/login" element={<Navigate to="/tasks/new" replace />} />
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route path="/*" element={<AppShell />} />
            </Routes>
          </OrganizationProvider>
        </AuthProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  );
}
