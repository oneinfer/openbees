import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isRecord } from './errors.js';
import { expandHomePrefix } from './paths.js';

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function firstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (hasOwn(record, key)) return record[key];
  }
  return undefined;
}

export function resolveWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('Working repo path cannot be empty');

  const resolvedPath = resolve(expandHomePrefix(trimmed));
  let stats;
  try {
    stats = statSync(resolvedPath);
  } catch {
    throw new Error('Working repo path does not exist');
  }

  if (!stats.isDirectory()) {
    throw new Error('Working repo path must point to a directory');
  }

  return resolvedPath;
}

export function parseWorkspacePath(body: unknown): string | null | undefined {
  const record = isRecord(body) ? body : {};
  const value = firstPresent(record, ['workspacePath', 'workspace_path', 'repoPath', 'repo_path']);

  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('workspacePath must be a string or null');

  const trimmed = value.trim();
  if (!trimmed) return null;
  return resolveWorkspacePath(trimmed);
}
