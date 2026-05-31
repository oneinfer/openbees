import { basename } from 'node:path';
import { Router } from 'express';
import { deleteProject, getAllProjects, getAppSetting, saveProject, setAppSetting } from '../db/queries.js';
import { broadcast } from '../events.js';
import { parseWorkspacePath } from '../workspace-access.js';

export const projectsRouter = Router();
export const CURRENT_PROJECT_SETTING_KEY = 'current_project_path';

function projectLabel(path: string): string {
  return basename(path) || path;
}

projectsRouter.get('/', (_req, res) => {
  res.json({ projects: getAllProjects() });
});

projectsRouter.get('/current', (_req, res) => {
  res.json({ workspacePath: getAppSetting(CURRENT_PROJECT_SETTING_KEY) });
});

projectsRouter.put('/current', (req, res) => {
  let path: string | null | undefined;
  try {
    path = parseWorkspacePath(req.body);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid project path' });
  }

  if (path === undefined) return res.status(400).json({ error: 'workspacePath is required' });

  if (path === null) {
    setAppSetting(CURRENT_PROJECT_SETTING_KEY, null);
    return res.json({ workspacePath: null, project: null });
  }

  const project = saveProject({ path, label: projectLabel(path) });
  setAppSetting(CURRENT_PROJECT_SETTING_KEY, path);
  broadcast({ type: 'project_saved', project });
  res.json({ workspacePath: path, project });
});

projectsRouter.post('/', (req, res) => {
  let path: string | null | undefined;
  try {
    path = parseWorkspacePath(req.body);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid project path' });
  }

  if (!path) return res.status(400).json({ error: 'workspacePath is required' });

  const label = typeof req.body?.label === 'string' && req.body.label.trim()
    ? req.body.label.trim()
    : projectLabel(path);
  const project = saveProject({ path, label });
  setAppSetting(CURRENT_PROJECT_SETTING_KEY, path);
  broadcast({ type: 'project_saved', project });
  res.status(201).json({ project });
});

projectsRouter.delete('/', (req, res) => {
  let path: string | null | undefined;
  try {
    path = parseWorkspacePath(req.body);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid project path' });
  }

  if (!path) return res.status(400).json({ error: 'workspacePath is required' });

  const result = deleteProject(path);
  if (!result.deleted) return res.status(404).json({ error: 'Project not found' });

  if (getAppSetting(CURRENT_PROJECT_SETTING_KEY) === path) setAppSetting(CURRENT_PROJECT_SETTING_KEY, null);
  broadcast({ type: 'project_deleted', path, taskIds: result.taskIds });
  res.json({ ok: true, taskIds: result.taskIds });
});
