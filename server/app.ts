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
import { activityRouter } from './routes/activity.js';
import { AgentRegistry } from './adapters/registry.js';
import { qwenAsr } from './asr/qwen-worker.js';
import { activityDaemon } from './activity-daemon.js';
import { initSSE, addClient, sendEvent } from './events.js';
import { getRunStatuses } from './live-chat.js';

const app = express();

app.use(cors());

const agents = new AgentRegistry();

app.get('/api/health', async (_req, res) => {
  const [runtimes, asr, activity] = await Promise.all([
    agents.health(),
    qwenAsr.status(),
    activityDaemon.status(),
  ]);
  res.json({ ok: true, runtimes, hermes: runtimes.hermes, asr, activity });
});

app.get('/api/events', (req, res) => {
  initSSE(res);
  addClient(res);
  sendEvent(res, { type: 'task_runs_snapshot', runs: getRunStatuses() });
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
app.use('/api/activity', activityRouter);
app.use('/api/cron', createCronRouter(agents.hermes));
app.use('/api/skills', skillsRouter);
app.use('/api/system', systemRouter);

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!res.headersSent && error && typeof error === 'object' && (error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  next(error);
});

export { agents, qwenAsr, activityDaemon };
export default app;
