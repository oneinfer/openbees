import { basename } from 'node:path';
import { Router } from 'express';
import { deleteProject, getAllProjects, getAppSetting, saveProject, setAppSetting } from '../db/queries.js';
import { deleteTaskAttachments } from '../attachments.js';
import { broadcast } from '../events.js';
import { parseWorkspacePath } from '../workspace-access.js';
import { loadOrganizationAccess, type OrganizationAccessContext } from '../organization-access.js';
import type { Project } from '../../shared/types.js';

export const projectsRouter = Router();
export const CURRENT_PROJECT_SETTING_KEY = 'current_project_path';

function projectLabel(path: string): string {
  return basename(path) || path;
}

function projectVisibleToContext(project: Project, context: OrganizationAccessContext): boolean {
  if (project.organization_id) return project.organization_id === context.organizationId;
  return Boolean(project.creator_developer_id && project.creator_developer_id === context.developerId);
}

function projectOwnerFields(context: OrganizationAccessContext): Pick<Project, 'organization_id' | 'creator_developer_id'> {
  return {
    organization_id: context.organizationId,
    creator_developer_id: context.developerId,
  };
}

projectsRouter.get('/', async (req, res) => {
  try {
    const context = await loadOrganizationAccess(req);
    res.json({ projects: getAllProjects().filter((project) => projectVisibleToContext(project, context)) });
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Organization access denied' });
  }
});

projectsRouter.get('/current', async (req, res) => {
  try {
    const context = await loadOrganizationAccess(req);
    const workspacePath = getAppSetting(CURRENT_PROJECT_SETTING_KEY);
    if (!workspacePath) return res.json({ workspacePath: null });
    const project = getAllProjects().find((candidate) => candidate.path === workspacePath);
    res.json({ workspacePath: project && projectVisibleToContext(project, context) ? workspacePath : null });
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Organization access denied' });
  }
});

projectsRouter.put('/current', async (req, res) => {
  let context: OrganizationAccessContext;
  try {
    context = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: error instanceof Error ? error.message : 'Organization access denied' });
  }
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

  const project = saveProject({ path, label: projectLabel(path), ...projectOwnerFields(context) });
  setAppSetting(CURRENT_PROJECT_SETTING_KEY, path);
  broadcast({ type: 'project_saved', project });
  res.json({ workspacePath: path, project });
});

projectsRouter.post('/', async (req, res) => {
  let context: OrganizationAccessContext;
  try {
    context = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: error instanceof Error ? error.message : 'Organization access denied' });
  }
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
  const project = saveProject({ path, label, ...projectOwnerFields(context) });
  setAppSetting(CURRENT_PROJECT_SETTING_KEY, path);
  broadcast({ type: 'project_saved', project });
  res.status(201).json({ project });
});

projectsRouter.delete('/', async (req, res) => {
  let context: OrganizationAccessContext;
  try {
    context = await loadOrganizationAccess(req);
  } catch (error) {
    return res.status(403).json({ error: error instanceof Error ? error.message : 'Organization access denied' });
  }
  let path: string | null | undefined;
  try {
    path = parseWorkspacePath(req.body);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid project path' });
  }

  if (!path) return res.status(400).json({ error: 'workspacePath is required' });
  const existing = getAllProjects().find((project) => project.path === path);
  if (!existing || !projectVisibleToContext(existing, context)) return res.status(404).json({ error: 'Project not found' });

  const result = deleteProject(path);
  if (!result.deleted) return res.status(404).json({ error: 'Project not found' });
  await Promise.all(result.taskIds.map((taskId) => deleteTaskAttachments(taskId).catch((error) => {
    console.warn(`Failed to delete attachments for task ${taskId}:`, error);
  })));

  if (getAppSetting(CURRENT_PROJECT_SETTING_KEY) === path) setAppSetting(CURRENT_PROJECT_SETTING_KEY, null);
  broadcast({ type: 'project_deleted', path, taskIds: result.taskIds });
  res.json({ ok: true, taskIds: result.taskIds });
});
