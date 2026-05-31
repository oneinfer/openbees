import { Router } from 'express';
import type { Request, Response } from 'express';
import { activityDaemon } from '../activity-daemon.js';

const router = Router();

function daemonPath(req: Request): string {
  const prefix = '/api/activity';
  return req.originalUrl.startsWith(prefix) ? req.originalUrl.slice(prefix.length) || '/' : req.url;
}

function unavailable(res: Response, error: unknown): void {
  res.status(503).json({
    error: error instanceof Error ? error.message : String(error),
    hint: 'Activity daemon is unavailable. Run npm run setup:activity to repair dependencies.',
  });
}

async function proxyJson(req: Request, res: Response, init: RequestInit = {}): Promise<void> {
  try {
    const response = await activityDaemon.request(daemonPath(req), init);
    const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
    const body = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', contentType);
    res.send(body);
  } catch (error) {
    unavailable(res, error);
  }
}

router.get('/health', async (req, res) => {
  await proxyJson(req, res);
});

router.get('/events/latest', async (req, res) => {
  await proxyJson(req, res);
});

router.get('/events', async (req, res) => {
  await proxyJson(req, res);
});

router.post('/arm', async (req, res) => {
  await proxyJson(req, res, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body ?? {}),
  });
});

router.post('/speech/suppress', async (req, res) => {
  await proxyJson(req, res, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body ?? {}),
  });
});

router.post('/speech/release', async (req, res) => {
  await proxyJson(req, res, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body ?? {}),
  });
});

router.post('/capture', async (req, res) => {
  await proxyJson(req, res, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req.body ?? {}),
  });
});

router.get('/stream', async (_req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    const response = await activityDaemon.request('/events/stream', { signal: controller.signal });
    if (!response.ok || !response.body) {
      res.status(response.status || 503).json({ error: `Activity daemon stream returned ${response.status}.` });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const reader = response.body.getReader();
    try {
      while (!res.writableEnded) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (!res.headersSent) unavailable(res, error);
    else res.end();
  }
});

export const activityRouter = router;
