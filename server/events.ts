import type { Response } from 'express';
import type { BoardEvent } from '../shared/types.js';
import { getTask } from './db/queries.js';
import { taskVisibleToOrganizationContext, type OrganizationAccessContext } from './organization-access.js';

export type { BoardEvent };

interface EventClient {
  res: Response;
  context: OrganizationAccessContext;
}

const clients = new Set<EventClient>();

const KEEPALIVE_INTERVAL_MS = 30_000;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    for (const client of clients) {
      try { client.res.write(':keepalive\n\n'); } catch { clients.delete(client); }
    }
    if (clients.size === 0) {
      clearInterval(keepaliveTimer!);
      keepaliveTimer = null;
    }
  }, KEEPALIVE_INTERVAL_MS);
}

export function initSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

export function addClient(res: Response, context: OrganizationAccessContext) {
  const client = { res, context };
  clients.add(client);
  res.on('close', () => clients.delete(client));
  startKeepalive();
}

export function clientCount(): number {
  return clients.size;
}

function eventVisibleToClient(event: BoardEvent, context: OrganizationAccessContext): boolean {
  if (event.type === 'task_created' || event.type === 'task_updated') {
    return taskVisibleToOrganizationContext(event.task, context);
  }
  if (event.type === 'task_deleted') {
    if (event.task) return taskVisibleToOrganizationContext(event.task, context);
    return true;
  }
  if (event.type === 'task_run_updated') {
    const task = getTask(event.run.taskId);
    return task ? taskVisibleToOrganizationContext(task, context) : true;
  }
  return true;
}

function writeEvent(res: Response, event: BoardEvent): boolean {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  try {
    return res.write(data);
  } catch {
    return false;
  }
}

export function sendEvent(res: Response, event: BoardEvent): void {
  writeEvent(res, event);
}

export function broadcast(event: BoardEvent) {
  for (const client of clients) {
    let visibleEvent = event;
    if (event.type === 'task_runs_snapshot') {
      visibleEvent = {
        ...event,
        runs: event.runs.filter((run) => {
          const task = getTask(run.taskId);
          return task ? taskVisibleToOrganizationContext(task, client.context) : true;
        }),
      };
    } else if (!eventVisibleToClient(event, client.context)) {
      continue;
    }
    if (!writeEvent(client.res, visibleEvent)) clients.delete(client);
  }
}
