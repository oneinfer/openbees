import { Router } from 'express';
import type { Request, Response } from 'express';
import { tokenFromRequest, parseCookies } from '../auth.js';

export const router = Router();

const DEFAULT_ONEINFER_API_BASE_URL = 'http://localhost:8001/api/v1';
const ORG_UPSTREAM_TIMEOUT_MS = 30_000;

function oneInferBaseUrl(): string {
  return (
    process.env.ONEINFER_API_BASE_URL ||
    process.env.VITE_ONEINFER_API_BASE_URL ||
    DEFAULT_ONEINFER_API_BASE_URL
  ).replace(/\/$/, '');
}

router.all('/*', async (req: Request, res: Response) => {
  const upstreamPath = req.path === '/' ? '' : req.path;
  const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const url = `${oneInferBaseUrl()}/organization${upstreamPath}${queryString}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ORG_UPSTREAM_TIMEOUT_MS);

  const token = tokenFromRequest(req);
  const cookie = req.header('cookie');
  const csrfToken = req.header('x-csrf-token');

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (cookie) headers['Cookie'] = cookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (hasBody) headers['Content-Type'] = 'application/json';

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Organization API timed out'
      : `Organization API unavailable: ${error instanceof Error ? error.message : String(error)}`;
    res.status(502).json({ detail: msg });
    return;
  }
  clearTimeout(timeoutId);

  const text = await upstreamRes.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = { detail: text }; }

  res.status(upstreamRes.status).json(body ?? {});
});

export { router as organizationRouter };
