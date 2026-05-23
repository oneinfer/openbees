import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function expandHomePrefix(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value: string): string {
  return resolve(expandHomePrefix(value));
}

export function resolveBeesHome(): string {
  const configured = process.env.BEES_HOME?.trim();
  return resolveHomeAwarePath(configured || '~/.bees');
}

export function resolveBeesDataDir(): string {
  return join(resolveBeesHome(), 'data');
}

export function resolveBeesLogsDir(): string {
  return join(resolveBeesHome(), 'logs');
}

export function resolveBeesWorkspaceDir(): string {
  return join(resolveBeesHome(), 'workspace');
}

export function resolveBeesDbPath(): string {
  const configured = process.env.DB_PATH?.trim();
  if (configured) return resolveHomeAwarePath(configured);
  return join(resolveBeesDataDir(), 'bees.db');
}

export function ensureBeesStateDirs(): void {
  const dbPath = resolveBeesDbPath();
  mkdirSync(resolveBeesDataDir(), { recursive: true });
  mkdirSync(resolveBeesLogsDir(), { recursive: true });
  mkdirSync(resolveBeesWorkspaceDir(), { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
}
