import { useEffect, useMemo, useRef } from 'react';
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Board } from './components/Board';
import { NewTaskPage } from './components/NewTaskPage';
import { ChatPage } from './components/ChatPage';
import { TaskDetailPage } from './components/TaskDetailPage';
import { SettingsPage } from './components/SettingsPage';
import { CronPage } from './components/CronPage';
import { SkillsPage } from './components/SkillsPage';
import { FileBrowserPage } from './components/FileBrowserPage';
import { ProjectsPage } from './components/ProjectsPage';
import { TaskCreatedToast } from './components/TaskCreatedToast';
import { useActivityCapture } from './hooks/useActivityCapture';
import { useTasks } from './hooks/useTasks';
import { useTheme } from './hooks/useTheme';
import { updateCurrentProject } from './lib/api';
import { useStore } from './lib/store';
import { normalizeProjectPath, projectHref } from './lib/projects';

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
          <Route path="/chats" element={<ChatPage />} />
          <Route path="/chats/:chatId" element={<ChatPage />} />
          <Route path="/tasks/new" element={<NewTaskPage />} />
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
      navigate(projectHref(currentProjectPath), { replace: true });
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
    if (location.pathname === '/tasks/new') return normalizeProjectPath(params.get('workspacePath'));
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
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
