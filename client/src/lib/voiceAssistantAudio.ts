import {
  fetchTtsStatus,
  liveTaskChatUrl,
  liveTaskTtsUrl,
  liveVoiceSessionChatUrl,
  liveVoiceSessionTtsUrl,
  synthesizeTts,
  type TtsStatusResponse,
} from './api';
import { AudioQueue, BrowserSpeechQueue } from './audioPlayback';

const WAKE_ACK_TEXT = 'Yes, I can hear you.';

type TtsEvent =
  | { type: 'ready'; enabled?: boolean; available?: boolean; error?: string }
  | { type: 'audio'; audioBase64: string; sampleRate: number; sampleCount?: number; segmentId?: number }
  | { type: 'dropped'; count?: number }
  | { type: 'error'; error?: string }
  | { type: 'end' };

type ChatLiveEvent =
  | { type: 'snapshot' }
  | { type: 'text_delta'; content?: string }
  | { type: 'done' }
  | { type: 'error'; error?: string };

const audioQueue = new AudioQueue();
const browserSpeech = new BrowserSpeechQueue();

let ttsSource: EventSource | null = null;
let chatSource: EventSource | null = null;
let ttsStatusPromise: Promise<TtsStatusResponse | null> | null = null;

function getTtsStatus(): Promise<TtsStatusResponse | null> {
  if (!ttsStatusPromise) {
    ttsStatusPromise = fetchTtsStatus().catch(() => null);
  }
  return ttsStatusPromise;
}

function closeSources(): void {
  ttsSource?.close();
  ttsSource = null;
  chatSource?.close();
  chatSource = null;
  browserSpeech.reset();
}

function attachTtsSource(url: string): void {
  const source = new EventSource(url);
  ttsSource = source;
  source.onmessage = (message) => {
    let event: TtsEvent;
    try {
      event = JSON.parse(message.data) as TtsEvent;
    } catch {
      return;
    }
    if (event.type === 'audio') {
      void audioQueue.play(event.audioBase64, event.sampleRate).catch(() => undefined);
    }
  };
  source.onerror = () => {};
}

function attachChatFallbackSource(url: string): void {
  const source = new EventSource(url);
  chatSource = source;
  source.onmessage = (message) => {
    let event: ChatLiveEvent;
    try {
      event = JSON.parse(message.data) as ChatLiveEvent;
    } catch {
      return;
    }
    if (event.type === 'text_delta' && event.content) browserSpeech.acceptText(event.content);
    if (event.type === 'done') browserSpeech.acceptText('', true);
  };
  source.onerror = () => {};
}

async function subscribe(ttsUrl: string, chatUrl: string): Promise<void> {
  closeSources();
  const status = await getTtsStatus();
  const outputReady = !!status?.enabled && !!status.available;
  if (outputReady) {
    attachTtsSource(ttsUrl);
    return;
  }
  if (browserSpeech.available()) attachChatFallbackSource(chatUrl);
}

export async function playWakeAck(): Promise<void> {
  if (browserSpeech.available()) {
    browserSpeech.acceptText(WAKE_ACK_TEXT, true);
    return;
  }
  const status = await getTtsStatus();
  if (!status?.enabled || !status.available) return;
  try {
    const result = await synthesizeTts(WAKE_ACK_TEXT);
    await audioQueue.play(result.audioBase64, result.sampleRate);
  } catch {
    // No playback path available — silently no-op for v1.
  }
}

export function subscribeVoiceTask(taskId: string): void {
  void subscribe(liveTaskTtsUrl(taskId), liveTaskChatUrl(taskId));
}

export function subscribeVoiceConversation(sessionId: string): void {
  void subscribe(liveVoiceSessionTtsUrl(sessionId), liveVoiceSessionChatUrl(sessionId));
}
