import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export type JwtPayload = {
  sub?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  exp?: number;
  iss?: string;
  aud?: string;
  type?: string;
  developer_id?: string;
  [key: string]: unknown;
};

function jwtSecret(): string {
  const secret = (process.env.JWT_SECRET_KEY || '').trim();
  if (!secret) console.warn('[auth] JWT_SECRET_KEY not set; using insecure fallback.');
  return secret || 'fallback-dev-secret-please-set-JWT_SECRET_KEY-in-env';
}

const REMOTE_AUTH_TIMEOUT_MS = 10_000;
const REMOTE_AUTH_CACHE_TTL_MS = 30_000;
const remoteAuthCache = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>();

function oneInferApiBaseUrl(): string {
  return (
    process.env.ONEINFER_API_BASE_URL
    || process.env.VITE_ONEINFER_API_BASE_URL
    || 'http://localhost:8001/api/v1'
  ).replace(/\/$/, '');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=');
        if (separator === -1) return [part, ''];
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

export function signJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createHmac('sha256', jwtSecret()).update(data).digest().toString('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest().toString('base64url');
  try {
    const aBuf = Buffer.from(sig, 'base64url');
    const bBuf = Buffer.from(expected, 'base64url');
    if (aBuf.length !== bBuf.length || !timingSafeEqual(aBuf, bBuf)) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

export async function resolveJwtPayload(token: string): Promise<Record<string, unknown> | null> {
  const localPayload = verifyJwt(token);
  if (localPayload) return localPayload;

  const cached = remoteAuthCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  if (cached) remoteAuthCache.delete(token);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REMOTE_AUTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${oneInferApiBaseUrl()}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const developer = await response.json() as Record<string, unknown>;
    if (typeof developer.developer_id !== 'string' || !developer.developer_id) return null;
    const payload = {
      sub: developer.developer_id,
      email: developer.email,
      first_name: developer.first_name,
      last_name: developer.last_name,
      type: 'access',
    };
    remoteAuthCache.set(token, { payload, expiresAt: Date.now() + REMOTE_AUTH_CACHE_TTL_MS });
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function tokenFromRequest(req: Request): string | null {
  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const queryToken = typeof req.query.accessToken === 'string' ? req.query.accessToken.trim() : '';
  if (queryToken) return queryToken;
  return parseCookies(req.header('cookie')).bees_access_token ?? null;
}

function isCookieAuthenticated(req: Request): boolean {
  const auth = req.header('authorization');
  return !(auth?.toLowerCase().startsWith('bearer ')) && Boolean(parseCookies(req.header('cookie')).bees_access_token);
}

function csrfValid(req: Request): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return true;
  if (!isCookieAuthenticated(req)) return true;
  const cookies = parseCookies(req.header('cookie'));
  const cookieToken = cookies.bees_csrf_token;
  const headerToken = req.header('x-csrf-token');
  return Boolean(cookieToken && headerToken && cookieToken === headerToken);
}

export async function requireApiAuth(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'OPTIONS') { next(); return; }

  const token = tokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    return;
  }
  if (!csrfValid(req)) {
    res.status(403).json({ error: 'CSRF validation failed', code: 'CSRF_INVALID' });
    return;
  }

  const payload = await resolveJwtPayload(token);
  // FastAPI tokens use 'developer_id'; Express-issued tokens use 'sub'
  const developerId = typeof payload?.developer_id === 'string' ? payload.developer_id
    : typeof payload?.sub === 'string' ? payload.sub
    : null;
  if (!payload || !developerId) {
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    return;
  }

  (req as Request & { developer?: JwtPayload; accessToken?: string }).developer = {
    sub: developerId,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    first_name: typeof payload.first_name === 'string' ? payload.first_name : undefined,
    last_name: typeof payload.last_name === 'string' ? payload.last_name : undefined,
  };
  (req as Request & { accessToken?: string }).accessToken = token;
  next();
}

export async function requireOrganizationApiAuth(req: Request, res: Response, next: NextFunction) {
  const organizationScoped = req.path === '/organization'
    || req.path.startsWith('/organization/')
    || Boolean(req.header('x-bees-organization-id')?.trim())
    || (typeof req.query.organizationId === 'string' && Boolean(req.query.organizationId.trim()));

  if (!organizationScoped) {
    next();
    return;
  }

  await requireApiAuth(req, res, next);
}
