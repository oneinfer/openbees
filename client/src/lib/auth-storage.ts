export const ACCESS_TOKEN_STORAGE_KEY = 'bees:accessToken';
export const REFRESH_TOKEN_STORAGE_KEY = 'bees:refreshToken';
export const DEVELOPER_STORAGE_KEY = 'bees:developer';
export const ACCESS_TOKEN_COOKIE_NAME = 'bees_access_token';
export const CSRF_TOKEN_COOKIE_NAME = 'bees_csrf_token';

export interface DeveloperProfile {
  developer_id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

export function getStoredAccessToken(): string | null {
  return readStorage(ACCESS_TOKEN_STORAGE_KEY);
}

export function getStoredRefreshToken(): string | null {
  return readStorage(REFRESH_TOKEN_STORAGE_KEY);
}

export function getStoredDeveloper(): DeveloperProfile | null {
  const raw = readStorage(DEVELOPER_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DeveloperProfile;
    return parsed && typeof parsed.developer_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function hasAuthSessionCookie(): boolean {
  return Boolean(getStoredAccessToken() || readCookie(CSRF_TOKEN_COOKIE_NAME));
}

export function storeAuthSession(accessToken: string | null | undefined, refreshToken: string | null | undefined, developer: DeveloperProfile): void {
  if (accessToken) writeStorage(ACCESS_TOKEN_STORAGE_KEY, accessToken);
  else removeStorage(ACCESS_TOKEN_STORAGE_KEY);

  if (refreshToken) writeStorage(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
  else removeStorage(REFRESH_TOKEN_STORAGE_KEY);

  writeStorage(DEVELOPER_STORAGE_KEY, JSON.stringify(developer));
}

export function clearAuthSession(): void {
  removeStorage(ACCESS_TOKEN_STORAGE_KEY);
  removeStorage(REFRESH_TOKEN_STORAGE_KEY);
  removeStorage(DEVELOPER_STORAGE_KEY);
}