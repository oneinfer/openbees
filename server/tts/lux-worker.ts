import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expandHomePrefix, resolveBeesHome } from '../paths.js';

const DEFAULT_MODEL = 'YatharthS/LuxTTS';

type LuxTtsRequest =
  | { id: string; type: 'health' }
  | { id: string; type: 'load' }
  | { id: string; type: 'synthesize'; text: string };

type LuxTtsEvent =
  | { id: string; type: 'result'; data: unknown }
  | { id: string; type: 'error'; error: { message: string; traceback?: string } | string };

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null };

export interface LuxTtsAudioResult { sampleRate: number; format: 'pcm_s16le'; audioBase64: string; sampleCount?: number }

export class LuxTtsError extends Error {
  constructor(message: string) { super(message); this.name = 'LuxTtsError'; }
}

function isEnabled(): boolean { return process.env.LUX_TTS_ENABLED?.trim().toLowerCase() === 'true'; }
function modelName(): string { return process.env.LUX_TTS_MODEL?.trim() || DEFAULT_MODEL; }
function device(): string { return process.env.LUX_TTS_DEVICE?.trim() || process.env.GRANITE_ASR_DEVICE?.trim() || 'cpu'; }
function referenceAudioPath(): string {
  const configured = process.env.LUX_TTS_REFERENCE_AUDIO_PATH?.trim();
  if (!configured) return '';
  const expanded = expandHomePrefix(configured);
  return resolve(expanded);
}

function resolveLuxPython(): string {
  if (process.env.LUX_TTS_PYTHON?.trim()) return expandHomePrefix(process.env.LUX_TTS_PYTHON.trim());
  if (process.env.GRANITE_ASR_PYTHON?.trim()) return expandHomePrefix(process.env.GRANITE_ASR_PYTHON.trim());
  const localVenv = resolve(process.cwd(), '.venv-granite-asr');
  const candidate = process.platform === 'win32' ? join(localVenv, 'Scripts', 'python.exe') : join(localVenv, 'bin', 'python');
  return existsSync(candidate) ? candidate : (process.platform === 'win32' ? 'python' : 'python3');
}

function resolveWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../workers/lux_tts_worker.py'),
    resolve(here, '../../server/workers/lux_tts_worker.py'),
    resolve(process.cwd(), 'server/workers/lux_tts_worker.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`LuxTTS worker script not found. Tried: ${candidates.join(', ')}`);
  return found;
}

function workerEnv(): NodeJS.ProcessEnv {
  const { PYTHONHOME: _pythonHome, PYTHONPATH: _pythonPath, ...env } = process.env;
  return {
    ...env,
    PYTHONIOENCODING: 'utf-8',
    TOKENIZERS_PARALLELISM: 'false',
    HF_HUB_VERBOSITY: 'error',
    LUX_TTS_MODEL: modelName(),
    LUX_TTS_DEVICE: device(),
    LUX_TTS_THREADS: process.env.LUX_TTS_THREADS?.trim() || '2',
    LUX_TTS_REFERENCE_AUDIO_PATH: referenceAudioPath(),
    LUX_TTS_NUM_STEPS: process.env.LUX_TTS_NUM_STEPS?.trim() || '4',
    LUX_TTS_T_SHIFT: process.env.LUX_TTS_T_SHIFT?.trim() || '0.9',
    LUX_TTS_SPEED: process.env.LUX_TTS_SPEED?.trim() || '1.0',
  };
}

function formatWorkerError(error: Extract<LuxTtsEvent, { type: 'error' }>['error']): LuxTtsError {
  if (typeof error === 'string') return new LuxTtsError(error);
  return new LuxTtsError(error.message || 'LuxTTS worker error');
}

class LuxTtsWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readline: Interface | null = null;
  private pending = new Map<string, PendingRequest>();
  private ready = false;
  private readyPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    this.ensureStarted();
    if (this.ready) return;
    if (!this.readyPromise) {
      this.readyPromise = this.request<{ ok: boolean }>('health')
        .then((result) => { if (!result.ok) throw new LuxTtsError('LuxTTS worker healthcheck failed'); this.ready = true; })
        .catch((error) => { this.ready = false; if (this.child && !this.child.killed) this.child.kill(); throw error; })
        .finally(() => { this.readyPromise = null; });
    }
    await this.readyPromise;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.child;
    this.child = null; this.ready = false; this.readyPromise = null;
    if (this.readline) { this.readline.close(); this.readline = null; }
    this.failPending(new LuxTtsError('LuxTTS worker stopped'));
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolveStop(); }, 500);
      timer.unref();
      child.once('exit', () => { clearTimeout(timer); resolveStop(); });
      child.once('error', () => { clearTimeout(timer); resolveStop(); });
      try { if (!child.stdin.destroyed) child.stdin.end(); } catch {}
      if (!child.killed) child.kill(signal);
    });
  }

  async request<T>(type: 'health' | 'load', timeoutMs?: number): Promise<T>;
  async request<T>(request: Omit<Extract<LuxTtsRequest, { type: 'synthesize' }>, 'id'>, timeoutMs?: number): Promise<T>;
  async request<T>(input: 'health' | 'load' | Omit<Extract<LuxTtsRequest, { type: 'synthesize' }>, 'id'>, timeoutMs?: number): Promise<T> {
    this.ensureStarted();
    const id = randomUUID();
    const request: LuxTtsRequest = typeof input === 'string' ? { id, type: input } : { ...input, id };
    return await new Promise<T>((resolveRequest, rejectRequest) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs != null && timeoutMs > 0) {
        timer = setTimeout(() => { this.pending.delete(id); rejectRequest(new LuxTtsError(`LuxTTS request timed out after ${timeoutMs}ms`)); }, timeoutMs);
        timer.unref();
      }
      this.pending.set(id, { timer, resolve: (value) => resolveRequest(value as T), reject: rejectRequest });
      try { this.write(request); } catch (error) { this.pending.delete(id); if (timer) clearTimeout(timer); rejectRequest(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private ensureStarted(): void {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    const child = spawn(resolveLuxPython(), [resolveWorkerScript()], { cwd: resolveBeesHome(), env: workerEnv() });
    mkdirSync(resolveBeesHome(), { recursive: true });
    this.child = child; this.ready = false;
    this.readline = createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => process.stderr.write(`[lux-tts-worker] ${String(chunk)}`));
    child.on('error', (error) => this.handleExit(error));
    child.on('exit', (code, signal) => this.handleExit(new LuxTtsError(`LuxTTS worker exited (${signal ?? code ?? 'unknown'})`)));
  }

  private handleLine(line: string): void {
    let event: LuxTtsEvent;
    try { event = JSON.parse(line) as LuxTtsEvent; } catch { process.stderr.write(`[lux-tts-worker] non-json stdout: ${line}\n`); return; }
    const pending = this.pending.get(event.id);
    if (!pending) return;
    this.pending.delete(event.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (event.type === 'result') pending.resolve(event.data);
    else pending.reject(formatWorkerError(event.error));
  }

  private handleExit(error: Error): void {
    if (this.readline) { this.readline.close(); this.readline = null; }
    this.child = null; this.ready = false; this.readyPromise = null;
    this.failPending(new LuxTtsError(`LuxTTS worker crashed: ${error.message}`));
  }

  private write(request: LuxTtsRequest): void {
    if (!this.child || !this.child.stdin.writable) throw new LuxTtsError('LuxTTS worker is not running');
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) { if (pending.timer) clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
  }
}

class LuxTtsService {
  private client = new LuxTtsWorkerClient();
  private queue: Promise<unknown> = Promise.resolve();
  private preloadPromise: Promise<void> | null = null;

  enabled(): boolean { return isEnabled(); }
  referenceAudioPath(): string { return referenceAudioPath(); }
  configured(): boolean {
    const referenceAudio = this.referenceAudioPath();
    return Boolean(referenceAudio && existsSync(referenceAudio));
  }
  configurationError(): string | undefined {
    if (!this.enabled()) return undefined;
    const referenceAudio = this.referenceAudioPath();
    if (!referenceAudio) return 'LUX_TTS_REFERENCE_AUDIO_PATH is not set';
    if (!existsSync(referenceAudio)) return `LUX_TTS_REFERENCE_AUDIO_PATH does not exist: ${referenceAudio}`;
    return undefined;
  }
  async stop(): Promise<void> { await this.client.stop(); this.preloadPromise = null; }

  async preload(): Promise<void> {
    if (!this.enabled()) return;
    const configError = this.configurationError();
    if (configError) throw new LuxTtsError(configError);
    if (!this.preloadPromise) {
      this.preloadPromise = this.client.start().then(async () => { await this.client.request<{ ok: boolean }>('load'); }).catch((error) => { this.preloadPromise = null; throw error; });
    }
    await this.preloadPromise;
  }

  async status(): Promise<{ enabled: boolean; available: boolean; model: string; device: string; error?: string }> {
    const base = { enabled: this.enabled(), available: false, model: modelName(), device: device() };
    if (!base.enabled) return base;
    const configError = this.configurationError();
    if (configError) return { ...base, error: configError };
    try { await this.client.start(); return { ...base, available: true }; }
    catch (error) { return { ...base, error: error instanceof Error ? error.message : String(error) }; }
  }

  async synthesize(text: string): Promise<LuxTtsAudioResult> {
    if (!this.enabled()) throw new LuxTtsError('LuxTTS is disabled. Set LUX_TTS_ENABLED=true to enable live voice.');
    const configError = this.configurationError();
    if (configError) throw new LuxTtsError(configError);
    const run = async () => { await this.preload(); return await this.client.request<LuxTtsAudioResult>({ type: 'synthesize', text }); };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return await next;
  }
}

export const luxTts = new LuxTtsService();
