import type { Response } from 'express';
import { initSSE } from '../events.js';
import { luxTts } from './lux-worker.js';

const SENTENCE_PATTERN = /(.+?[.!?])(?:\s+|$)/s;

interface LiveTtsState {
  subscribers: Set<Response>;
  buffer: string;
  queue: Array<{ id: number; text: string }>;
  sequence: number;
  processing: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const states = new Map<string, LiveTtsState>();

function segmentMaxChars(): number { return Math.max(80, Number(process.env.LUX_TTS_SEGMENT_MAX_CHARS ?? 420)); }
function flushMs(): number { return Math.max(50, Number(process.env.LUX_TTS_SEGMENT_FLUSH_MS ?? 900)); }
function maxQueuedSegments(): number { return Math.max(1, Number(process.env.LUX_TTS_QUEUE_MAX_SEGMENTS ?? 12)); }
function enabled(): boolean { return process.env.LUX_TTS_ENABLED?.trim().toLowerCase() === 'true'; }

function stateFor(taskId: string): LiveTtsState {
  let state = states.get(taskId);
  if (!state) {
    state = { subscribers: new Set(), buffer: '', queue: [], sequence: 0, processing: false, flushTimer: null };
    states.set(taskId, state);
  }
  return state;
}

function writeEvent(res: Response, event: Record<string, unknown>): boolean {
  try { return res.write(`data: ${JSON.stringify(event)}\n\n`); }
  catch { return false; }
}

function clearState(taskId: string, state: LiveTtsState): void {
  state.buffer = '';
  state.queue = [];
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  if (state.subscribers.size === 0) states.delete(taskId);
}

function broadcast(taskId: string, event: Record<string, unknown>): void {
  const state = states.get(taskId);
  if (!state) return;
  for (const subscriber of state.subscribers) {
    if (!writeEvent(subscriber, event)) state.subscribers.delete(subscriber);
  }
  if (state.subscribers.size === 0) clearState(taskId, state);
}

function enqueue(taskId: string, state: LiveTtsState, text: string): void {
  const segment = text.trim();
  if (!segment) return;
  state.sequence += 1;
  state.queue.push({ id: state.sequence, text: segment });
  let dropped = 0;
  while (state.queue.length > maxQueuedSegments()) { state.queue.shift(); dropped += 1; }
  if (dropped) broadcast(taskId, { type: 'dropped', count: dropped });
}

function extractReadySegments(taskId: string, state: LiveTtsState): void {
  while (true) {
    const text = state.buffer.trim();
    if (!text) { state.buffer = ''; return; }
    const match = text.match(SENTENCE_PATTERN);
    if (match?.index === 0 && match[1]) {
      enqueue(taskId, state, match[1]);
      state.buffer = text.slice(match[0].length).trim();
      continue;
    }
    const maxChars = segmentMaxChars();
    if (text.length >= maxChars) {
      let splitAt = text.lastIndexOf(' ', maxChars);
      if (splitAt < 80) splitAt = maxChars;
      enqueue(taskId, state, text.slice(0, splitAt));
      state.buffer = text.slice(splitAt).trim();
      continue;
    }
    state.buffer = text;
    return;
  }
}

function flushBuffer(taskId: string, state: LiveTtsState): void {
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = null;
  enqueue(taskId, state, state.buffer);
  state.buffer = '';
}

async function processQueue(taskId: string, state: LiveTtsState): Promise<void> {
  if (state.processing) return;
  state.processing = true;
  try {
    while (state.subscribers.size > 0 && state.queue.length > 0) {
      const segment = state.queue.shift();
      if (!segment) continue;
      try {
        const audio = await luxTts.synthesize(segment.text);
        broadcast(taskId, { type: 'audio', segmentId: segment.id, ...audio });
      } catch (error) {
        broadcast(taskId, { type: 'error', error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    state.processing = false;
  }
}

class LiveTtsCoordinator {
  enabled(): boolean { return enabled(); }
  async status() { const status = await luxTts.status(); return { ...status, sampleRate: 48000, segmentMaxChars: segmentMaxChars() }; }
  preload(): Promise<void> { return luxTts.preload(); }
  stop(): Promise<void> { return luxTts.stop(); }

  acceptDelta(taskId: string, text: string, options: { forceFlush?: boolean } = {}): void {
    if (!enabled() || !text) return;
    const state = states.get(taskId);
    if (!state || state.subscribers.size === 0) return;
    state.buffer += text;
    extractReadySegments(taskId, state);
    if (options.forceFlush) {
      flushBuffer(taskId, state);
    } else if (state.buffer && !state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        const current = states.get(taskId);
        if (!current) return;
        flushBuffer(taskId, current);
        void processQueue(taskId, current);
      }, flushMs());
      state.flushTimer.unref?.();
    }
    void processQueue(taskId, state);
  }

  end(taskId: string): void {
    const state = states.get(taskId);
    if (!state) return;
    flushBuffer(taskId, state);
    void processQueue(taskId, state).finally(() => broadcast(taskId, { type: 'end' }));
  }

  subscribe(taskId: string, res: Response): void {
    initSSE(res);
    const state = stateFor(taskId);
    state.subscribers.add(res);
    void this.status()
      .then((status) => writeEvent(res, { type: 'ready', ...status }))
      .catch((error) => writeEvent(res, { type: 'ready', enabled: enabled(), available: false, error: error instanceof Error ? error.message : String(error) }));
    res.on('close', () => {
      state.subscribers.delete(res);
      if (state.subscribers.size === 0) clearState(taskId, state);
    });
  }
}

export const liveTts = new LiveTtsCoordinator();
