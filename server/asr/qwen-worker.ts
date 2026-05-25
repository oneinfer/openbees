import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { AsrStatusResponse, AsrTranscriptionResponse } from '../../shared/types.js';
import { expandHomePrefix, resolveBeesHome } from '../paths.js';

const WORKER_READY_TIMEOUT_MS = 10_000;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const MODEL_LOAD_TIMEOUT_MS = Number(process.env.QWEN_ASR_LOAD_TIMEOUT_MS ?? 20 * 60_000);

type QwenAsrRequest =
  | { id: string; type: 'health' }
  | { id: string; type: 'load' }
  | { id: string; type: 'transcribe'; audioPath: string; language?: string | null };

type QwenAsrEvent =
  | { id: string; type: 'result'; data: unknown }
  | { id: string; type: 'error'; error: { message: string; code?: string } | string };

type QwenAsrErrorPayload = Extract<QwenAsrEvent, { type: 'error' }>['error'];

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

export class QwenAsrError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'QwenAsrError';
    this.code = code;
  }
}

function isEnabled(): boolean {
  return process.env.QWEN_ASR_ENABLED?.trim().toLowerCase() === 'true';
}

function asrModel(): string {
  return process.env.QWEN_ASR_MODEL?.trim() || 'Qwen/Qwen3-ASR-0.6B';
}

function asrDevice(): string {
  return process.env.QWEN_ASR_DEVICE?.trim() || 'cuda:0';
}

function asrDtype(): string {
  return process.env.QWEN_ASR_DTYPE?.trim() || 'bfloat16';
}

function resolveQwenPython(): string {
  if (process.env.QWEN_ASR_PYTHON?.trim()) return expandHomePrefix(process.env.QWEN_ASR_PYTHON.trim());

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

function resolveWorkerScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../workers/qwen_asr_worker.py'),
    resolve(here, '../../server/workers/qwen_asr_worker.py'),
    resolve(process.cwd(), 'server/workers/qwen_asr_worker.py'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Qwen ASR worker script not found. Tried: ${candidates.join(', ')}`);
  return found;
}

function workerEnv(): NodeJS.ProcessEnv {
  const { PYTHONHOME: _pythonHome, PYTHONPATH: _pythonPath, ...env } = process.env;
  return {
    ...env,
    PYTHONIOENCODING: 'utf-8',
    TRANSFORMERS_VERBOSITY: 'error',
    TOKENIZERS_PARALLELISM: 'false',
    HF_HUB_VERBOSITY: 'error',
    QWEN_ASR_MODEL: asrModel(),
    QWEN_ASR_DEVICE: asrDevice(),
    QWEN_ASR_DTYPE: asrDtype(),
  };
}

function formatWorkerError(error: QwenAsrErrorPayload): QwenAsrError {
  if (typeof error === 'string') return new QwenAsrError(error);
  return new QwenAsrError(error.message || 'Qwen ASR worker error', error.code);
}

class QwenAsrWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readline: Interface | null = null;
  private pending = new Map<string, PendingRequest>();
  private ready = false;
  private readyPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    this.ensureStarted();
    if (this.ready) return;

    if (!this.readyPromise) {
      this.readyPromise = this.request<{ ok: boolean }>('health', WORKER_READY_TIMEOUT_MS)
        .then((result) => {
          if (!result.ok) throw new QwenAsrError('Qwen ASR worker healthcheck failed', 'health_failed');
          this.ready = true;
        })
        .catch((error) => {
          this.ready = false;
          if (this.child && !this.child.killed) this.child.kill();
          throw error;
        })
        .finally(() => {
          this.readyPromise = null;
        });
    }

    await this.readyPromise;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.readyPromise = null;

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    this.failPending(new QwenAsrError('Qwen ASR worker stopped', 'stopped'));
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
      }, 500);
      forceTimer.unref();

      child.once('exit', () => {
        clearTimeout(forceTimer);
        done();
      });
      child.once('error', () => {
        clearTimeout(forceTimer);
        done();
      });

      try {
        if (!child.stdin.destroyed) child.stdin.end();
      } catch {
        // The process may already be gone.
      }

      if (!child.killed) child.kill(signal);
    });
  }

  async request<T>(type: 'health' | 'load', timeoutMs?: number): Promise<T>;
  async request<T>(request: Omit<Extract<QwenAsrRequest, { type: 'transcribe' }>, 'id'>, timeoutMs?: number): Promise<T>;
  async request<T>(
    input: 'health' | 'load' | Omit<Extract<QwenAsrRequest, { type: 'transcribe' }>, 'id'>,
    timeoutMs = TRANSCRIBE_TIMEOUT_MS,
  ): Promise<T> {
    this.ensureStarted();

    const id = randomUUID();
    const request: QwenAsrRequest = typeof input === 'string' ? { id, type: input } : { ...input, id };

    return await new Promise<T>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new QwenAsrError(`Qwen ASR request timed out after ${timeoutMs}ms`, 'timeout'));
      }, timeoutMs);
      timeout.unref();

      this.pending.set(id, {
        timeout,
        resolve: (value) => resolveRequest(value as T),
        reject: rejectRequest,
      });

      try {
        this.write(request);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureStarted(): void {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;

    const python = resolveQwenPython();
    const script = resolveWorkerScript();
    const cwd = resolveBeesHome();
    mkdirSync(cwd, { recursive: true });

    const child = spawn(python, [script], {
      cwd,
      env: workerEnv(),
    });

    this.child = child;
    this.ready = false;
    this.readline = createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
    child.on('error', (error) => this.handleExit(error));
    child.on('exit', (code, signal) => {
      this.handleExit(new QwenAsrError(`Qwen ASR worker exited (${signal ?? code ?? 'unknown'})`, 'worker_exit'));
    });
  }

  private handleLine(line: string): void {
    let event: QwenAsrEvent;
    try {
      event = JSON.parse(line) as QwenAsrEvent;
    } catch {
      process.stderr.write(`[qwen-asr-worker] non-json stdout: ${line}\n`);
      return;
    }

    const pending = this.pending.get(event.id);
    if (!pending) return;

    this.pending.delete(event.id);
    if (pending.timeout) clearTimeout(pending.timeout);

    if (event.type === 'result') pending.resolve(event.data);
    else pending.reject(formatWorkerError(event.error));
  }

  private handleExit(error: Error): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    this.child = null;
    this.ready = false;
    this.readyPromise = null;
    this.failPending(new QwenAsrError(`Qwen ASR worker crashed: ${error.message}`, 'worker_crashed'));
  }

  private write(request: QwenAsrRequest): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new QwenAsrError('Qwen ASR worker is not running', 'not_running');
    }
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class QwenAsrService {
  private client = new QwenAsrWorkerClient();
  private queue: Promise<unknown> = Promise.resolve();
  private preloadPromise: Promise<void> | null = null;

  async stop(): Promise<void> {
    await this.client.stop();
    this.preloadPromise = null;
  }

  enabled(): boolean {
    return isEnabled();
  }

  async preload(): Promise<void> {
    if (!isEnabled()) return;

    if (!this.preloadPromise) {
      this.preloadPromise = this.client.start()
        .then(async () => {
          await this.client.request<{ ok: boolean }>('load', MODEL_LOAD_TIMEOUT_MS);
        })
        .catch((error) => {
          this.preloadPromise = null;
          throw error;
        });
    }

    await this.preloadPromise;
  }

  async status(): Promise<AsrStatusResponse> {
    const base = {
      enabled: isEnabled(),
      available: false,
      model: asrModel(),
      device: asrDevice(),
      dtype: asrDtype(),
    };

    if (!base.enabled) return base;

    try {
      await this.client.start();
      return { ...base, available: true };
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async transcribe(audioPath: string, language?: string | null): Promise<AsrTranscriptionResponse> {
    if (!isEnabled()) throw new QwenAsrError('Qwen ASR is disabled. Set QWEN_ASR_ENABLED=true to enable voice input.', 'disabled');

    const startedAt = Date.now();
    const run = async () => {
      await this.preload();
      const result = await this.client.request<{ text?: string; language?: string | null }>({
        type: 'transcribe',
        audioPath,
        language: language || null,
      });
      return {
        text: (result.text ?? '').trim(),
        language: result.language ?? null,
        durationMs: Date.now() - startedAt,
      };
    };

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return await next;
  }
}

export const qwenAsr = new QwenAsrService();
