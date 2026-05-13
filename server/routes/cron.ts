import { Router, type Response } from 'express';
import { getTask } from '../db/queries.js';
import { toErrorMessage } from '../errors.js';
import type { CronJob } from '../../shared/types.js';
import type { HermesWorkerAdapter } from '../adapters/hermes-worker.js';

function originTaskId(job: CronJob): string | null {
  const origin = job.origin;
  if (!origin || origin.platform !== 'minions') return null;
  return typeof origin.chat_id === 'string' && origin.chat_id.trim() ? origin.chat_id : null;
}

function attachLinkedTaskId(job: CronJob): CronJob {
  const taskId = originTaskId(job);
  return { ...job, linkedTaskIds: taskId ? [taskId] : [] };
}

export function createCronRouter(adapter: HermesWorkerAdapter): Router {
  const router = Router();

  router.get('/jobs', async (req, res) => {
    try {
      const includeDisabled = req.query.includeDisabled === 'true';
      const jobs = await adapter.listCronJobs(includeDisabled);
      res.json({ jobs: jobs.map(attachLinkedTaskId) });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes cron worker unavailable') });
    }
  });

  router.get('/jobs/:jobId', async (req, res) => {
    try {
      const job = await adapter.getCronJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Cron job not found' });
      res.json({ job: attachLinkedTaskId(job) });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes cron worker unavailable') });
    }
  });

  router.get('/jobs/:jobId/runs', async (req, res) => {
    try {
      const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
      const limit = rawLimit ? Number.parseInt(String(rawLimit), 10) : 20;
      const runs = await adapter.getCronRuns(req.params.jobId, Number.isFinite(limit) ? limit : 20);
      res.json({ runs });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes cron worker unavailable') });
    }
  });

  router.get('/jobs/:jobId/runs/:runId/content', async (req, res) => {
    try {
      const content = await adapter.getCronRunContent(req.params.jobId, req.params.runId);
      res.json({ content });
    } catch (error) {
      const status = (error as { code?: string }).code === 'not_found' ? 404 : 503;
      res.status(status).json({ error: toErrorMessage(error, 'Hermes cron worker unavailable') });
    }
  });

  async function jobActionHandler(
    res: Response,
    jobId: string,
    action: (jobId: string) => Promise<CronJob | null>,
  ) {
    try {
      const job = await action(jobId);
      if (!job) return res.status(404).json({ error: 'Cron job not found' });
      res.json({ job: attachLinkedTaskId(job) });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes cron worker unavailable') });
    }
  }

  router.post('/jobs/:jobId/pause', (req, res) => {
    const rawReason = req.body?.reason;
    const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : undefined;
    jobActionHandler(res, req.params.jobId, (jobId) => adapter.pauseCronJob(jobId, reason));
  });

  router.post('/jobs/:jobId/resume', (req, res) => {
    jobActionHandler(res, req.params.jobId, (jobId) => adapter.resumeCronJob(jobId));
  });

  router.post('/jobs/:jobId/run', (req, res) => {
    jobActionHandler(res, req.params.jobId, (jobId) => adapter.runCronJob(jobId));
  });

  router.delete('/jobs/:jobId', async (req, res) => {
    try {
      const removed = await adapter.removeCronJob(req.params.jobId);
      if (!removed) return res.status(404).json({ error: 'Cron job not found' });
      res.json({ ok: true });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes cron worker unavailable') });
    }
  });

  return router;
}

export function createTaskCronRouter(adapter: HermesWorkerAdapter): Router {
  const router = Router();

  router.get('/:id/cron-jobs', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    try {
      const jobs = await adapter.listCronJobs(true);
      const linkedJobs = jobs.filter((job) => originTaskId(job) === task.id);
      res.json({ jobs: linkedJobs.map(attachLinkedTaskId) });
    } catch (error) {
      res.status(503).json({ error: toErrorMessage(error, 'Hermes cron worker unavailable') });
    }
  });

  return router;
}
