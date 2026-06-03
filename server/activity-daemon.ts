import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { broadcast, clientCount } from './events.js';
import { openBrowserForDev } from './browser-opener.js';
import { expandHomePrefix, resolveBeesHome } from './paths.js';
import { getActiveActivityAgentSettings } from './activity-agent-settings.js';
import { createTaskRecord, startTaskImmediately } from './task-service.js';
import { normalizeActivityIntentDecision } from './prompts/activity-intent.js';
import { appendAttachmentContext, saveActivityImageAttachments } from './attachments.js';
import { enrichImageAttachmentContext } from './image-context.js';
import { getActivityContextBySourceEventId, getAppSetting, insertActivityContext, updateTask } from './db/queries.js';
import { CURRENT_PROJECT_SETTING_KEY } from './routes/projects.js';
import { notifyTaskCreated } from './native-notifications.js';
import type { ActivityContext, ActivityIntentDecision } from '../shared/types.js';

const HEALTH_TIMEOUT_MS = 1200;
const STARTUP_POLL_MS = 250;
const STARTUP_TIMEOUT_MS = Number(process.env.BEES_ACTIVITY_STARTUP_TIMEOUT_MS ?? 20 * 60_000);
const WAKE_BROWSER_OPEN_DEBOUNCE_MS = 5000;

export interface ActivityDaemonStatus {
  enabled: boolean;
  available: boolean;
  managed: boolean;
  url: string;
  error?: string;
  daemon?: unknown;
}

interface ActivityDaemonEvent {
  id?: string;
  timestamp?: string;
  trigger?: string;
  spoken_input?: string;
  active_window?: {
    title?: string | null;
    app_name?: string | null;
    process_name?: string | null;
  } | null;
  text?: {
    selection_text?: string;
    selection_text_source?: string | null;
    primary_selection_text?: string;
    clipboard_text?: string;
    hover_text?: string;
    focused_text?: string;
  };
  images?: {
    cursor_crop?: ActivityImage | null;
    selection_crop?: ActivityImage | null;
    screenshot?: ActivityImage | null;
  };
  files?: {
    event_json?: string;
  };
}

interface ActivityImage {
  path?: string;
  width?: number;
  height?: number;
}

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function activityHost(): string {
  return process.env.BEES_ACTIVITY_HOST?.trim() || '127.0.0.1';
}

function activityPort(): number {
  const configured = Number(process.env.BEES_ACTIVITY_PORT ?? '4768');
  return Number.isFinite(configured) && configured > 0 ? configured : 4768;
}

function activityUrl(): string {
  return `http://${activityHost()}:${activityPort()}`;
}

function activityEnabled(): boolean {
  return envFlagEnabled(process.env.BEES_ACTIVITY_ENABLED, true);
}

function activityPython(): string {
  if (process.env.BEES_ACTIVITY_PYTHON?.trim()) return expandHomePrefix(process.env.BEES_ACTIVITY_PYTHON.trim());

  const localVenv = resolve(process.cwd(), '.venv-qwen-asr');
  const homeVenv = join(resolveBeesHome(), 'qwen-asr-venv');
  const candidates = process.platform === 'win32'
    ? [
        join(localVenv, 'Scripts', 'python.exe'),
        join(homeVenv, 'Scripts', 'python.exe'),
      ]
    : [
        join(localVenv, 'bin', 'python'),
        join(homeVenv, 'bin', 'python'),
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function activityDataDir(): string {
  if (process.env.BEES_ACTIVITY_DATA_DIR?.trim()) return expandHomePrefix(process.env.BEES_ACTIVITY_DATA_DIR.trim());
  return join(resolveBeesHome(), 'activity-daemon');
}

function activityPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const configured = process.env.BEES_ACTIVITY_PACKAGE_ROOT?.trim();
  const candidates = [
    configured ? resolve(expandHomePrefix(configured)) : null,
    resolve(process.cwd(), 'activity_daemon'),
    resolve(here, '../activity_daemon'),
    resolve(here, '../../activity_daemon'),
  ].filter(Boolean) as string[];

  const found = candidates.find((candidate) => existsSync(join(candidate, 'daemon.py')));
  if (!found) throw new Error(`activity_daemon package not found. Tried: ${candidates.join(', ')}`);
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = HEALTH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedText(event: ActivityDaemonEvent): string {
  return event.text?.selection_text?.trim() || '';
}

function hasCapturedContext(event: ActivityDaemonEvent): boolean {
  return Boolean(
    selectedText(event)
    || event.active_window
    || event.images?.screenshot
    || event.images?.selection_crop
    || event.images?.cursor_crop,
  );
}

function hasCapturedImage(event: ActivityDaemonEvent): boolean {
  return Boolean(event.images?.screenshot || event.images?.selection_crop || event.images?.cursor_crop);
}

function transcriptRequestsImageBackedWork(transcript: string): boolean {
  const normalized = transcript.trim().toLowerCase();
  if (!normalized) return false;

  const hasAction = /\b(create|build|make|design|clone|copy|recreate|replicate|implement|generate|modify|update|turn|convert)\b/.test(normalized);
  const hasDeliverable = /\b(website|site|webpage|page|app|ui|screen|layout|component|design|interface|landing|dashboard|form|flow)\b/.test(normalized);
  const referencesCapture = /\b(like this|based on this|from this|using this|this screenshot|this image|the screenshot|the image|what'?s shown|visible)\b/.test(normalized);

  return hasAction && (hasDeliverable || referencesCapture);
}

function imageBackedTaskDecision(
  event: ActivityDaemonEvent,
  decision: ActivityIntentDecision,
  transcript: string,
): ActivityIntentDecision {
  if (decision.action === 'create_task' && decision.hasEnoughContext) return decision;
  if (!hasCapturedImage(event) || !transcriptRequestsImageBackedWork(transcript)) return decision;

  return {
    action: 'create_task',
    title: transcript.trim().slice(0, 80) || 'Voice task from screenshot',
    taskDescription: transcript.trim(),
    hasEnoughContext: true,
    reason: 'The spoken request is actionable and the captured screenshot provides the visual reference for the task agent.',
  };
}

function activityImageValues(event: ActivityDaemonEvent): unknown[] {
  return [
    event.images?.selection_crop,
    event.images?.screenshot,
    event.images?.cursor_crop,
  ].filter(Boolean);
}

function buildActivityTaskDescription(
  event: ActivityDaemonEvent,
  decision: ActivityIntentDecision,
  transcript: string,
): string {
  const userRequest = transcript.trim() || selectedText(event) || decision.title;
  return userRequest || 'Captured screenshot.';
}

function isTaskCreatingActivityEvent(event: ActivityDaemonEvent): boolean {
  return event.trigger === 'voice_selection' || event.trigger === 'voice_screenshot';
}

function normalizedTranscript(event: ActivityDaemonEvent): string {
  const transcript = event.spoken_input?.trim() ?? '';
  return transcript === '[input pending]' ? '' : transcript;
}

function isFreshEvent(event: ActivityDaemonEvent, connectedAt: number): boolean {
  if (!event.timestamp) return true;
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp >= connectedAt - 2000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}

function activityReadiness(data: unknown): { ready: true } | { ready: false; error?: string; pending?: string } {
  const collectors = nestedRecord(data, 'collectors');
  const speech = nestedRecord(collectors, 'speech');

  if (!speech || speech.enabled === false) return { ready: true };

  const lastError = typeof speech.last_error === 'string' && speech.last_error.trim() ? speech.last_error.trim() : undefined;
  const lastStatus = typeof speech.last_status === 'string' ? speech.last_status : '';
  const modelLoaded = speech.model_loaded === true;
  const vadEnabled = speech.vad_enabled !== false;
  const vadAvailable = speech.vad_available === true;
  const vadModelLoaded = speech.vad_model_loaded === true;
  const vadLastError = typeof speech.vad_last_error === 'string' && speech.vad_last_error.trim() ? speech.vad_last_error.trim() : undefined;
  const statusLower = lastStatus.toLowerCase();

  if (statusLower.includes('stopped') || statusLower.includes('error')) {
    return { ready: false, error: lastStatus || lastError || 'Activity speech listener failed.' };
  }

  if (lastError && !lastError.startsWith('Wake word heard;')) {
    return { ready: false, error: lastError };
  }

  if (!modelLoaded) return { ready: false, pending: lastStatus || 'Activity ASR model is loading.' };
  if (vadEnabled && !Object.hasOwn(speech, 'vad_model_loaded')) {
    return { ready: false, error: 'Activity daemon is running old speech code without required VAD status. Restart the existing daemon.' };
  }
  if (vadEnabled && !vadAvailable) return { ready: false, error: vadLastError || 'Required Silero VAD is unavailable.' };
  if (vadEnabled && !vadModelLoaded) return { ready: false, pending: lastStatus || 'Required Silero VAD model is loading.' };
  if (
    statusLower.includes('starting')
    || statusLower.includes('loading')
    || statusLower.includes('calibrating')
  ) {
    return { ready: false, pending: lastStatus };
  }
  if (!lastStatus || statusLower === 'not started') return { ready: false, pending: 'Activity speech listener is not started yet.' };
  if (
    statusLower.includes('listening for wake phrase')
    || statusLower.includes('wake matched; armed for drag selection')
    || statusLower.includes('waiting for selection')
  ) {
    return { ready: true };
  }

  return { ready: false, pending: lastStatus || 'Activity speech listener is warming up.' };
}

function activitySpeechSummary(data: unknown): string {
  const collectors = nestedRecord(data, 'collectors');
  const speech = nestedRecord(collectors, 'speech');
  if (!speech || speech.enabled === false) return 'speech disabled';

  const pieces = [
    `available=${speech.available === true}`,
    `asr_loaded=${speech.model_loaded === true}`,
  ];

  if (Object.hasOwn(speech, 'vad_model_loaded')) {
    pieces.push(`vad_available=${speech.vad_available === true}`);
    pieces.push(`vad_loaded=${speech.vad_model_loaded === true}`);
  } else {
    pieces.push('vad_status=missing_old_daemon');
  }

  const lastStatus = typeof speech.last_status === 'string' && speech.last_status.trim() ? speech.last_status.trim() : undefined;
  const lastError = typeof speech.last_error === 'string' && speech.last_error.trim() ? speech.last_error.trim() : undefined;
  const vadLastError = typeof speech.vad_last_error === 'string' && speech.vad_last_error.trim() ? speech.vad_last_error.trim() : undefined;
  const gateReason = typeof speech.last_gate_reason === 'string' && speech.last_gate_reason.trim() ? speech.last_gate_reason.trim() : undefined;
  if (lastStatus) pieces.push(`status="${lastStatus}"`);
  if (lastError) pieces.push(`error="${lastError}"`);
  if (vadLastError) pieces.push(`vad_error="${vadLastError}"`);
  if (gateReason) pieces.push(`gate="${gateReason}"`);
  return pieces.join(', ');
}

class ActivityDaemonService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private managed = false;
  private lastError: string | undefined;
  private startPromise: Promise<void> | null = null;
  private eventStreamAbort: AbortController | null = null;
  private eventStreamReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private processedEventIds = new Set<string>();
  private wakeUiUrl: string | null = null;
  private lastWakeBrowserOpenAt = 0;

  enabled(): boolean {
    return activityEnabled();
  }

  url(): string {
    return activityUrl();
  }

  async start(): Promise<void> {
    if (!this.enabled()) {
      this.lastError = undefined;
      return;
    }

    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const existing = await this.fetchHealth();
    if (existing.ok) {
      this.managed = false;
      console.log(`[activity-daemon] using existing daemon at ${this.url()}`);
      console.log(`[activity-daemon] existing speech status: ${activitySpeechSummary(existing.data)}`);
      await this.waitUntilReady();
      return;
    }

    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return;
    }

    try {
      const packageRoot = activityPackageRoot();
      const python = activityPython();
      const cwd = dirname(packageRoot);
      const child = spawn(python, ['-m', 'activity_daemon.daemon', '--host', activityHost(), '--port', String(activityPort())], {
        cwd,
        env: {
          ...process.env,
          ONEINFER_ACTIVITY_DATA_DIR: activityDataDir(),
          PYTHONIOENCODING: 'utf-8',
          TRANSFORMERS_VERBOSITY: process.env.TRANSFORMERS_VERBOSITY ?? 'error',
          TOKENIZERS_PARALLELISM: process.env.TOKENIZERS_PARALLELISM ?? 'false',
          HF_HUB_VERBOSITY: process.env.HF_HUB_VERBOSITY ?? 'error',
        },
      });

      this.child = child;
      this.managed = true;
      this.lastError = 'Activity daemon is starting.';

      child.stdout.on('data', (chunk) => this.writeChildOutput(process.stdout, String(chunk)));
      child.stderr.on('data', (chunk) => this.writeChildOutput(process.stderr, String(chunk)));
      child.on('error', (error) => {
        this.lastError = error.message;
      });
      child.on('exit', (code, signal) => {
        this.child = null;
        if (this.managed) this.lastError = `Activity daemon exited (${signal ?? code ?? 'unknown'}).`;
      });

      console.log(`[activity-daemon] starting at ${this.url()}`);
      await this.waitUntilReady(child);
    } catch (error) {
      this.lastError = formatError(error);
      throw error;
    }
  }

  private writeChildOutput(stream: NodeJS.WriteStream, chunk: string): void {
    const lines = chunk.split(/(?<=\n)/);
    for (const line of lines) {
      if (!line) continue;
      stream.write(line.startsWith('[activity-daemon]') ? line : `[activity-daemon] ${line}`);
    }
  }

  private async waitUntilReady(child?: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastPending = '';
    while (Date.now() < deadline) {
      const health = await this.fetchHealth();
      if (health.ok) {
        const readiness = activityReadiness(health.data);
        if (readiness.ready) {
          this.lastError = undefined;
          console.log(`[activity-daemon] ready: ${activitySpeechSummary(health.data)}`);
          return;
        }
        if (readiness.error) {
          this.lastError = readiness.error;
          throw new Error(readiness.error);
        }
        if (readiness.pending && readiness.pending !== lastPending) {
          lastPending = readiness.pending;
          console.log(`[activity-daemon] waiting: ${readiness.pending}`);
        }
      }
      if (child && child.exitCode !== null) break;
      await sleep(STARTUP_POLL_MS);
    }
    this.lastError = this.lastError ?? `Activity daemon did not become ready within ${STARTUP_TIMEOUT_MS}ms.`;
    throw new Error(this.lastError);
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.stopEventSubscription();

    const child = this.child;
    this.child = null;
    this.managed = false;
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolveStop) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolveStop();
      };

      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        done();
      }, 1000);
      forceTimer.unref();

      child.once('exit', () => {
        clearTimeout(forceTimer);
        done();
      });
      child.once('error', () => {
        clearTimeout(forceTimer);
        done();
      });

      if (!child.killed) child.kill(signal);
    });
  }

  async status(): Promise<ActivityDaemonStatus> {
    const base = {
      enabled: this.enabled(),
      available: false,
      managed: this.managed,
      url: this.url(),
    };

    if (!base.enabled) return base;

    const health = await this.fetchHealth();
    if (health.ok) {
      const readiness = activityReadiness(health.data);
      if (!readiness.ready) {
        return {
          ...base,
          error: readiness.error ?? readiness.pending ?? 'Activity daemon is starting.',
          daemon: health.data,
        };
      }
      this.lastError = undefined;
      return {
        ...base,
        available: true,
        daemon: health.data,
      };
    }

    return {
      ...base,
      error: health.error ?? this.lastError ?? 'Activity daemon is unavailable. Run npm run setup:activity to repair dependencies.',
    };
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.enabled()) throw new Error('Activity daemon is disabled. Set BEES_ACTIVITY_ENABLED=true to enable it.');
    return await fetch(`${this.url()}${path}`, init);
  }

  openUiOnWake(url: string): void {
    this.wakeUiUrl = url;
    if (this.enabled()) this.startEventSubscription();
  }

  private startEventSubscription(): void {
    this.stopEventSubscription();

    const controller = new AbortController();
    const connectedAt = Date.now();
    this.eventStreamAbort = controller;

    void this.consumeEventStream(controller, connectedAt).catch((error) => {
      if (controller.signal.aborted || !this.enabled()) return;
      console.warn(`[activity-daemon] activity event stream disconnected: ${formatError(error)}`);
      this.eventStreamReconnectTimer = setTimeout(() => {
        this.eventStreamReconnectTimer = null;
        if (this.enabled()) this.startEventSubscription();
      }, 2000);
    });
  }

  private stopEventSubscription(): void {
    if (this.eventStreamReconnectTimer) {
      clearTimeout(this.eventStreamReconnectTimer);
      this.eventStreamReconnectTimer = null;
    }
    this.eventStreamAbort?.abort();
    this.eventStreamAbort = null;
  }

  private async consumeEventStream(controller: AbortController, connectedAt: number): Promise<void> {
    const response = await fetch(`${this.url()}/events/stream`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Activity event stream returned ${response.status}.`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = this.sseSeparatorIndex(buffer);
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + this.sseSeparatorLength(buffer, separatorIndex));
        this.handleSseBlock(block, connectedAt);
        separatorIndex = this.sseSeparatorIndex(buffer);
      }
    }
  }

  private sseSeparatorIndex(buffer: string): number {
    const lf = buffer.indexOf('\n\n');
    const crlf = buffer.indexOf('\r\n\r\n');
    if (lf === -1) return crlf;
    if (crlf === -1) return lf;
    return Math.min(lf, crlf);
  }

  private sseSeparatorLength(buffer: string, index: number): number {
    return buffer.slice(index, index + 4) === '\r\n\r\n' ? 4 : 2;
  }

  private handleSseBlock(block: string, connectedAt: number): void {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) return;

    try {
      void this.handleActivityEvent(JSON.parse(dataLines.join('\n')) as ActivityDaemonEvent, connectedAt)
        .catch((error) => {
          console.warn(`[activity-daemon] failed to process activity event: ${formatError(error)}`);
        });
    } catch (error) {
      console.warn(`[activity-daemon] ignored malformed activity event: ${formatError(error)}`);
    }
  }

  private async handleActivityEvent(event: ActivityDaemonEvent, connectedAt: number): Promise<void> {
    if (!isFreshEvent(event, connectedAt)) return;
    if (event.trigger === 'voice_wake') {
      this.openUiForWake();
      return;
    }
    if (!isTaskCreatingActivityEvent(event)) return;

    const eventId = event.id || `${event.timestamp ?? ''}:${event.trigger ?? ''}`;
    if (!eventId || this.processedEventIds.has(eventId)) return;
    this.rememberEvent(eventId);

    await this.processVoiceActivityEvent(event);
  }

  private openUiForWake(): void {
    if (!this.wakeUiUrl) return;
    if (clientCount() > 0) return;

    const now = Date.now();
    if (now - this.lastWakeBrowserOpenAt < WAKE_BROWSER_OPEN_DEBOUNCE_MS) return;
    this.lastWakeBrowserOpenAt = now;

    console.log(`[activity-daemon] wake phrase detected; opening ${this.wakeUiUrl}`);
    openBrowserForDev(this.wakeUiUrl);
  }

  private rememberEvent(id: string): void {
    this.processedEventIds.add(id);
    if (this.processedEventIds.size <= 500) return;
    const oldest = this.processedEventIds.values().next().value;
    if (oldest) this.processedEventIds.delete(oldest);
  }

  private async processVoiceActivityEvent(event: ActivityDaemonEvent): Promise<void> {
    const transcript = normalizedTranscript(event);
    const capturedText = selectedText(event);
    let decision: ActivityIntentDecision;

    if (!transcript && !hasCapturedContext(event)) {
      decision = {
        action: 'save_context',
        title: 'Saved voice context',
        taskDescription: '',
        hasEnoughContext: false,
        reason: 'Spoken input and captured context are empty or still pending.',
      };
      await this.broadcastActivityDraft(event, decision, capturedText);
      return;
    }

    try {
      const activeSettings = getActiveActivityAgentSettings();
      decision = await this.judgeActivityIntent(transcript, event, activeSettings);
      decision = imageBackedTaskDecision(event, decision, transcript);
    } catch (error) {
      decision = {
        action: 'save_context',
        title: 'Saved voice context',
        taskDescription: transcript,
        hasEnoughContext: false,
        reason: `Activity intent classification failed: ${formatError(error)}`,
      };
      await this.broadcastActivityDraft(event, decision, capturedText);
      return;
    }

    if (decision.action === 'create_task' && decision.hasEnoughContext) {
      await this.createTaskFromActivityDecision(event, decision, transcript);
      return;
    }

    await this.broadcastActivityDraft(event, decision, capturedText);
  }

  private async judgeActivityIntent(
    transcript: string,
    event: ActivityDaemonEvent,
    activeSettings: ReturnType<typeof getActiveActivityAgentSettings>,
  ): Promise<ActivityIntentDecision> {
    const { agents } = await import('./app.js');
    const decision = await agents.adapterFor(activeSettings.runtime).judgeActivityIntent(transcript, {
      timestamp: event.timestamp ?? null,
      source: event.trigger ?? null,
      capturedText: selectedText(event) || null,
      activeWindow: event.active_window ?? null,
      images: event.images ?? null,
      model: activeSettings.model,
      reasoningEffort: activeSettings.reasoningEffort,
    });
    return normalizeActivityIntentDecision(decision, transcript || selectedText(event));
  }

  private async createTaskFromActivityDecision(
    event: ActivityDaemonEvent,
    decision: ActivityIntentDecision,
    transcript: string,
  ): Promise<void> {
    try {
      const description = buildActivityTaskDescription(event, decision, transcript);
      const activeSettings = getActiveActivityAgentSettings();
      const workspacePath = getAppSetting(CURRENT_PROJECT_SETTING_KEY);
      let task = createTaskRecord({
        title: transcript.trim() || decision.title,
        description,
        status: 'pending',
        taskKind: 'task',
        taskMode: 'direct',
        workspacePath,
        runtime: activeSettings.runtime,
        model: activeSettings.model,
        reasoningEffort: activeSettings.reasoningEffort,
      });
      const attachments = await enrichImageAttachmentContext(
        await saveActivityImageAttachments(task.id, activityImageValues(event)),
      );
      if (attachments.length > 0) {
        task = updateTask(task.id, {
          description: appendAttachmentContext(description, attachments),
        }) ?? task;
      }
      task = startTaskImmediately(task);
      notifyTaskCreated(task);
      broadcast({ type: 'task_created', task });
    } catch (error) {
      await this.broadcastActivityDraft(event, {
        ...decision,
        action: 'save_context',
        hasEnoughContext: false,
        reason: `Task creation failed: ${formatError(error)}`,
      }, selectedText(event));
    }
  }

  private async broadcastActivityDraft(
    event: ActivityDaemonEvent,
    decision: ActivityIntentDecision,
    capturedText: string,
  ): Promise<ActivityContext> {
    const existing = event.id ? getActivityContextBySourceEventId(event.id) : undefined;
    const context = existing ?? insertActivityContext({
      source_event_id: event.id ?? null,
      trigger: event.trigger ?? 'activity',
      spoken_input: normalizedTranscript(event) || event.spoken_input || null,
      captured_text: capturedText || null,
      active_window: event.active_window ?? null,
      images: event.images ?? null,
      decision,
      promoted_task_id: null,
    });
    broadcast({ type: 'activity_context_created', context });
    broadcast({ type: 'activity_draft_created', context });
    return context;
  }

  private async fetchHealth(): Promise<{ ok: true; data: unknown } | { ok: false; error?: string }> {
    try {
      const response = await fetchWithTimeout(`${this.url()}/health`);
      if (!response.ok) return { ok: false, error: `Activity daemon health returned ${response.status}.` };
      return { ok: true, data: await response.json() };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  }
}

export const activityDaemon = new ActivityDaemonService();
