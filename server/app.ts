import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { tasksRouter } from './routes/tasks.js';
import { chatRouter } from './routes/chat.js';
import { createAgentRouter, createTaskAgentSettingsRouter } from './routes/agent.js';
import { createCronRouter, createTaskCronRouter } from './routes/cron.js';
import { skillsRouter } from './routes/skills.js';
import { filesRouter } from './routes/files.js';
import { systemRouter } from './routes/system.js';
import { projectsRouter } from './routes/projects.js';
import { asrRouter } from './routes/asr.js';
import { ttsRouter } from './routes/tts.js';
import { activityRouter } from './routes/activity.js';
import { activityContextsRouter } from './routes/activity-contexts.js';
import { authRouter } from './routes/auth.js';
import { organizationRouter } from './routes/organization.js';
import { AgentRegistry } from './adapters/registry.js';
import { requireApiAuth, requireOrganizationApiAuth } from './auth.js';
import { graniteAsr } from './asr/granite-worker.js';
import { liveTts } from './tts/live-tts.js';
import { activityDaemon } from './activity-daemon.js';
import { initSSE, addClient, sendEvent } from './events.js';
import { getRunStatuses } from './live-chat.js';
import { getTask } from './db/queries.js';
import { loadOrganizationAccess, taskVisibleToOrganizationContext } from './organization-access.js';

const app = express();

const defaultCorsPorts = new Set(['3000', '6969', process.env.PORT || '6969']);
const defaultCorsOrigins = Array.from(defaultCorsPorts).flatMap((port) => [
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
  `http://[::1]:${port}`,
]);
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : defaultCorsOrigins)
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    callback(new Error(`CORS origin denied: ${origin}`));
  },
}));

const agents = new AgentRegistry();

app.get('/api/health', async (_req, res) => {
  const [runtimes, asr, tts, activity] = await Promise.all([
    agents.health(),
    graniteAsr.status(),
    liveTts.status(),
    activityDaemon.status(),
  ]);
  res.json({ ok: true, runtimes, hermes: runtimes.hermes, asr, tts, activity });
});

// Public auth routes — mounted before requireApiAuth
app.use('/api/auth', express.json(), authRouter);

// Personal/local APIs remain available without login. Organization-scoped
// requests carry an organization header/query and require authentication.
app.use('/api', requireOrganizationApiAuth);

app.get('/api/events', async (req, res) => {
  let organizationContext;
  try {
    organizationContext = await loadOrganizationAccess(req);
  } catch (error) {
    res.status(403).json({ error: error instanceof Error ? error.message : 'Organization access denied' });
    return;
  }

  initSSE(res);
  addClient(res, organizationContext);
  const runs = getRunStatuses().filter((run) => {
    const task = getTask(run.taskId);
    return task ? taskVisibleToOrganizationContext(task, organizationContext) : true;
  });
  sendEvent(res, { type: 'task_runs_snapshot', runs });
});

app.use('/api/files', express.json({ limit: '25mb' }), filesRouter);

app.use(express.json());

app.use('/api/tasks', tasksRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/tasks', createTaskCronRouter(agents.hermes));
app.use('/api/tasks', createTaskAgentSettingsRouter(agents));
app.use('/api/tasks', chatRouter);
app.use('/api/agent', createAgentRouter(agents));
app.use('/api/asr', asrRouter);
app.use('/api/tts', ttsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/activity-contexts', activityContextsRouter);
app.use('/api/cron', createCronRouter(agents.hermes));
app.use('/api/skills', skillsRouter);
app.use('/api/system', systemRouter);
app.use('/api/organization', requireApiAuth, organizationRouter);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!res.headersSent && error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  next(error);
});

export { agents, graniteAsr, liveTts, activityDaemon };
export default app;
