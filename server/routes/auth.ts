import { Router } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { signJwt, resolveJwtPayload, tokenFromRequest, verifyJwtIgnoreExpiry, parseCookies } from '../auth.js';
import { isEnterpriseMode } from '../deployment-config.js';

export const router = Router();

const ACCESS_EXPIRE_SECONDS = parseInt(process.env.ACCESS_TOKEN_EXPIRE_MINUTES || '60', 10) * 60;
const REFRESH_EXPIRE_SECONDS = parseInt(process.env.REFRESH_TOKEN_EXPIRE_DAYS || '30', 10) * 24 * 60 * 60;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const OPENBEES_JWT_ISSUER = 'openbees-oneinfer';
const OPENBEES_JWT_AUDIENCE = 'openbees';
const DEFAULT_ONEINFER_API_BASE_URL = 'http://localhost:8001/api/v1';
const AUTH_UPSTREAM_TIMEOUT_MS = 30_000;

function oneInferBaseUrl(): string {
  return (
    process.env.ONEINFER_API_BASE_URL ||
    process.env.VITE_ONEINFER_API_BASE_URL ||
    DEFAULT_ONEINFER_API_BASE_URL
  ).replace(/\/$/, '');
}

function buildAccessToken(sub: string, email: unknown, firstName: unknown, lastName: unknown): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub,
    client_type: 'developer',
    email,
    first_name: firstName,
    last_name: lastName,
    type: 'access',
    iss: OPENBEES_JWT_ISSUER,
    aud: OPENBEES_JWT_AUDIENCE,
    jti: randomUUID().replace(/-/g, ''),
    iat: now,
    exp: now + ACCESS_EXPIRE_SECONDS,
  });
}

function buildRefreshToken(sub: string, email: unknown, firstName: unknown, lastName: unknown): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub,
    client_type: 'developer',
    email,
    first_name: firstName,
    last_name: lastName,
    type: 'refresh',
    iss: OPENBEES_JWT_ISSUER,
    aud: OPENBEES_JWT_AUDIENCE,
    jti: randomUUID().replace(/-/g, ''),
    iat: now,
    exp: now + REFRESH_EXPIRE_SECONDS,
  });
}

function setAuthCookies(res: Response, accessToken: string, refreshToken?: string): void {
  const csrfToken = randomBytes(32).toString('hex');
  const accessOptions = { secure: COOKIE_SECURE, sameSite: 'lax' as const, maxAge: ACCESS_EXPIRE_SECONDS * 1000 };
  const refreshOptions = { secure: COOKIE_SECURE, sameSite: 'lax' as const, maxAge: REFRESH_EXPIRE_SECONDS * 1000, httpOnly: true };
  res.cookie('bees_access_token', accessToken, { ...accessOptions, httpOnly: true });
  res.cookie('bees_csrf_token', csrfToken, { ...accessOptions, httpOnly: false });
  if (refreshToken) res.cookie('bees_refresh_token', refreshToken, refreshOptions);
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('bees_access_token');
  res.clearCookie('bees_csrf_token');
  res.clearCookie('bees_refresh_token');
}

function refreshTokenFromRequest(req: Request): string | null {
  const cookies = parseCookies(req.header('cookie') ?? '');
  if (cookies.bees_refresh_token) return cookies.bees_refresh_token;
  const body = req.body as Record<string, unknown>;
  return typeof body?.refresh_token === 'string' ? body.refresh_token : null;
}

async function proxyToUpstream(req: Request, res: Response, path: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTH_UPSTREAM_TIMEOUT_MS);
  const url = `${oneInferBaseUrl()}${path}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const authHeader = req.header('authorization');
  if (authHeader) headers['Authorization'] = authHeader;
  const cookie = req.header('cookie');
  if (cookie) headers['Cookie'] = cookie;
  const csrfToken = req.header('x-csrf-token');
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(url, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Authentication upstream timed out'
      : 'Authentication upstream unavailable';
    res.status(502).json({ detail: msg });
    return;
  }
  clearTimeout(timeoutId);

  const text = await upstreamRes.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { detail: text }; }

  if (upstreamRes.ok && typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (typeof b.access_token === 'string') {
      setAuthCookies(res, b.access_token);
    }
  }

  res.status(upstreamRes.status).json(body ?? {});
}

async function exchangeSsoTokenWithUpstream(token: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTH_UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(`${oneInferBaseUrl()}/auth/sso-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// GET /api/auth/config - returns Google client ID (public)
router.get('/config', (_req, res) => {
  res.json({ google_client_id: process.env.GOOGLE_CLIENT_ID || null });
});

// GET /api/auth/me - returns current developer profile from JWT
router.get('/me', async (req, res) => {
  const token = tokenFromRequest(req);
  if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }

  const payload = await resolveJwtPayload(token);
  const developerId = typeof payload?.developer_id === 'string' ? payload.developer_id
    : typeof payload?.sub === 'string' ? payload.sub
    : null;
  if (!payload || !developerId) { res.status(401).json({ error: 'Invalid or expired token' }); return; }

  res.json({
    developer_id: developerId,
    email: payload.email ?? null,
    first_name: payload.first_name ?? null,
    last_name: payload.last_name ?? null,
  });
});

// POST /api/auth/developer/google-login
router.post('/developer/google-login', async (req, res) => {
  if (isEnterpriseMode()) {
    await proxyToUpstream(req, res, '/auth/developer/google-login');
    return;
  }

  const { client_id, credential } = req.body as { client_id?: string; credential?: string };
  if (!credential) { res.status(400).json({ detail: 'credential is required' }); return; }

  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!googleClientId) { res.status(503).json({ detail: 'Google login is not configured on this server' }); return; }
  if (client_id && client_id !== googleClientId) {
    res.status(400).json({ detail: 'Google client_id mismatch' });
    return;
  }

  let tokenInfo: Record<string, unknown>;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
      { signal: controller.signal },
    ).finally(() => clearTimeout(id));
    if (!response.ok) { res.status(401).json({ detail: 'Invalid Google credential' }); return; }
    tokenInfo = await response.json() as Record<string, unknown>;
  } catch {
    res.status(502).json({ detail: 'Failed to verify Google credential' });
    return;
  }

  if (tokenInfo.aud !== googleClientId) { res.status(401).json({ detail: 'Google credential audience mismatch' }); return; }

  const email = typeof tokenInfo.email === 'string' ? tokenInfo.email : null;
  const developerId = typeof tokenInfo.sub === 'string' ? tokenInfo.sub : null;
  if (!email || !developerId) { res.status(401).json({ detail: 'Google credential missing required fields' }); return; }

  const firstName = typeof tokenInfo.given_name === 'string' ? tokenInfo.given_name : null;
  const lastName = typeof tokenInfo.family_name === 'string' ? tokenInfo.family_name : null;
  const accessToken = buildAccessToken(developerId, email, firstName, lastName);
  const refreshToken = buildRefreshToken(developerId, email, firstName, lastName);

  setAuthCookies(res, accessToken, refreshToken);
  res.json({
    developer_id: developerId,
    email,
    first_name: firstName,
    last_name: lastName,
    access_token: accessToken,
    refresh_token: refreshToken,
  });
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  if (isEnterpriseMode()) {
    await proxyToUpstream(req, res, '/auth/refresh');
    return;
  }

  // Prefer the dedicated refresh token; fall back to a still-valid access token
  // so existing sessions (no refresh token cookie yet) continue to work.
  const refreshToken = refreshTokenFromRequest(req);
  let payload: Record<string, unknown> | null = null;

  if (refreshToken) {
    // Verify the refresh token — it must be signed by us, not expired, and typed correctly.
    payload = verifyJwtIgnoreExpiry(refreshToken);
    if (payload && payload.type !== 'refresh') payload = null;
    if (payload) {
      const exp = typeof payload.exp === 'number' ? payload.exp : 0;
      if (Date.now() / 1000 > exp) payload = null; // truly expired refresh token
    }
  }

  if (!payload) {
    // Fallback: accept an access token that may be slightly expired (5-min grace window)
    const accessToken = tokenFromRequest(req);
    if (accessToken) {
      const raw = verifyJwtIgnoreExpiry(accessToken);
      if (raw) {
        const exp = typeof raw.exp === 'number' ? raw.exp : 0;
        const gracePeriod = 5 * 60;
        if (Date.now() / 1000 <= exp + gracePeriod) payload = raw;
      }
    }
  }

  if (!payload) { res.status(401).json({ detail: 'Session expired. Please sign in again.' }); return; }

  const developerId = typeof payload.sub === 'string' ? payload.sub
    : typeof payload.developer_id === 'string' ? payload.developer_id
    : null;
  if (!developerId) { res.status(401).json({ detail: 'Invalid token payload.' }); return; }

  const newAccessToken = buildAccessToken(developerId, payload.email, payload.first_name, payload.last_name);
  const newRefreshToken = buildRefreshToken(developerId, payload.email, payload.first_name, payload.last_name);

  setAuthCookies(res, newAccessToken, newRefreshToken);
  res.json({
    developer_id: developerId,
    email: payload.email ?? null,
    first_name: payload.first_name ?? null,
    last_name: payload.last_name ?? null,
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  if (isEnterpriseMode()) {
    void proxyToUpstream(req, res, '/auth/logout');
    return;
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

// OTP / registration stubs - 503 in standalone, proxy in enterprise
router.post('/generate-and-send-otp', async (req, res) => {
  if (isEnterpriseMode()) { await proxyToUpstream(req, res, '/auth/generate-and-send-otp'); return; }
  res.status(503).json({ detail: 'OTP login is not available in standalone mode' });
});

router.post('/verify-email-otp', async (req, res) => {
  if (isEnterpriseMode()) { await proxyToUpstream(req, res, '/auth/verify-email-otp'); return; }
  res.json({ is_verified: false, message: 'OTP login is not available in standalone mode' });
});

router.post('/developer/verify-registration', async (req, res) => {
  if (isEnterpriseMode()) { await proxyToUpstream(req, res, '/auth/developer/verify-registration'); return; }
  res.json({ is_registered: false });
});

router.post('/developer/consent', async (req, res) => {
  if (isEnterpriseMode()) { await proxyToUpstream(req, res, '/auth/developer/consent'); return; }
  res.json({ is_consent_given: true });
});

router.post('/developer/login', async (req, res) => {
  if (isEnterpriseMode()) { await proxyToUpstream(req, res, '/auth/developer/login'); return; }
  res.status(503).json({ detail: 'OTP login is not available in standalone mode' });
});

router.post('/developer/register', async (req, res) => {
  if (isEnterpriseMode()) { await proxyToUpstream(req, res, '/auth/developer/register'); return; }
  res.status(503).json({ detail: 'Registration is not available in standalone mode' });
});

// POST /api/auth/sso-token - exchange a JWT from enterprise login for a bees session
router.post('/sso-token', async (req, res) => {
  if (isEnterpriseMode()) {
    await proxyToUpstream(req, res, '/auth/sso-token');
    return;
  }

  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ detail: 'token is required' });
    return;
  }

  const session = await exchangeSsoTokenWithUpstream(token);
  const developerId = typeof session?.developer_id === 'string' ? session.developer_id : null;
  const accessToken = typeof session?.access_token === 'string' ? session.access_token : null;
  if (!session || !developerId || !accessToken) {
    res.status(401).json({ detail: 'Invalid or expired SSO token' });
    return;
  }

  const ssoRefreshToken = buildRefreshToken(developerId, session.email, session.first_name, session.last_name);
  setAuthCookies(res, accessToken, ssoRefreshToken);
  res.json({
    developer_id: developerId,
    email: session.email ?? null,
    first_name: session.first_name ?? null,
    last_name: session.last_name ?? null,
    access_token: accessToken,
    refresh_token: ssoRefreshToken,
  });
});

export { router as authRouter };
