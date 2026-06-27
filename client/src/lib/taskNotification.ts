import { BASE, apiAuthHeaders } from './api.js';

export const TASK_CREATED_EVENT = 'bees:task-created';

export interface TaskCreatedNotificationDetail {
  title: string;
  taskId?: string;
}

const TASK_NOTIFICATIONS_ENABLED_KEY = 'bees:taskNotificationsEnabled';
const TASK_NOTIFICATION_PREFERENCE_EVENT = 'bees:task-notification-preference';

let notificationPermissionRequest: Promise<NotificationPermission> | null = null;
const recentNotifications = new Map<string, number>();

export function announceTaskStarted(): void {
  void speakWithLuxTts('Task execution started').catch(() => speakWithBrowserSynthesis('Task execution started'));
}

const recentInReviewAnnouncements = new Map<string, number>();

export function announceTaskInReview(taskId: string): void {
  const now = Date.now();
  for (const [id, ts] of recentInReviewAnnouncements) {
    if (now - ts > 10000) recentInReviewAnnouncements.delete(id);
  }
  if (recentInReviewAnnouncements.has(taskId)) return;
  recentInReviewAnnouncements.set(taskId, now);
  void speakWithLuxTts('Task execution completed, ready for review').catch(() => speakWithBrowserSynthesis('Task execution completed, ready for review'));
}

export function announceTaskCreated(title = 'Task created', taskId?: string): void {
  if (taskId && wasRecentlyAnnounced(taskId)) return;

  window.dispatchEvent(new CustomEvent<TaskCreatedNotificationDetail>(TASK_CREATED_EVENT, {
    detail: { title, taskId },
  }));
  speakTaskCreated();
  showTaskCreatedSystemNotification(title, taskId);
}

export function primeTaskCreatedSound(): void {
  // no-op: sound replaced with speech synthesis
}

export function primeTaskCreatedNotifications(): void {
  if (!isTaskCreatedSystemNotificationSupported()) return;
  if (getTaskCreatedSystemNotificationPermission() !== 'default') return;

  void requestTaskCreatedSystemNotificationPermission().catch(() => {});
}

export function isTaskCreatedSystemNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getTaskCreatedSystemNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isTaskCreatedSystemNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

export function areTaskCreatedSystemNotificationsEnabled(): boolean {
  if (!isTaskCreatedSystemNotificationSupported()) return false;
  return Notification.permission === 'granted' && localStorage.getItem(TASK_NOTIFICATIONS_ENABLED_KEY) !== 'false';
}

export async function requestTaskCreatedSystemNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isTaskCreatedSystemNotificationSupported()) return 'unsupported';

  if (Notification.permission === 'granted') {
    setTaskCreatedSystemNotificationsEnabled(true);
    return 'granted';
  }

  if (Notification.permission === 'denied') {
    setTaskCreatedSystemNotificationsEnabled(false);
    return 'denied';
  }

  notificationPermissionRequest ??= Notification.requestPermission().finally(() => {
    notificationPermissionRequest = null;
  });

  const permission = await notificationPermissionRequest;
  setTaskCreatedSystemNotificationsEnabled(permission === 'granted');
  return permission;
}

export function setTaskCreatedSystemNotificationsEnabled(enabled: boolean): void {
  if (!isTaskCreatedSystemNotificationSupported()) return;
  localStorage.setItem(TASK_NOTIFICATIONS_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(TASK_NOTIFICATION_PREFERENCE_EVENT));
}

export function subscribeTaskCreatedSystemNotificationPreference(listener: () => void): () => void {
  window.addEventListener(TASK_NOTIFICATION_PREFERENCE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(TASK_NOTIFICATION_PREFERENCE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

function speakTaskCreated(): void {
  void speakWithLuxTts('Task created').catch(() => speakWithBrowserSynthesis('Task created'));
}

async function speakWithLuxTts(text: string): Promise<void> {
  const readCsrfToken = () => {
    const match = document.cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith('bees_csrf_token='));
    return match ? decodeURIComponent(match.slice('bees_csrf_token='.length)) : null;
  };
  const csrfToken = readCsrfToken();
  const res = await fetch(`${BASE}/tts/synthesize`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders(), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`LuxTTS synthesize failed: ${res.status}`);
  const { audioBase64, sampleRate } = await res.json() as { audioBase64: string; sampleRate: number };

  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const ctx = new AudioContext({ sampleRate });
  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  await new Promise<void>((resolve) => { source.onended = () => resolve(); });
  await ctx.close();
}

function speakWithBrowserSynthesis(text: string): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech synthesis may be blocked before a user gesture.
  }
}

function showTaskCreatedSystemNotification(title: string, taskId?: string): void {
  if (!areTaskCreatedSystemNotificationsEnabled()) return;

  try {
    const notification = new Notification('Bees task created', {
      body: title,
      icon: '/logo.png',
      tag: taskId ? `bees-task-created:${taskId}` : undefined,
    });

    notification.onclick = () => {
      window.focus();
      if (taskId) window.location.assign(`/tasks/${encodeURIComponent(taskId)}`);
      notification.close();
    };

    window.setTimeout(() => notification.close(), 8000);
  } catch {
    // Some browsers expose Notification but still block construction in edge cases.
  }
}

function wasRecentlyAnnounced(taskId: string): boolean {
  const now = Date.now();
  for (const [id, timestamp] of recentNotifications) {
    if (now - timestamp > 5000) recentNotifications.delete(id);
  }
  if (recentNotifications.has(taskId)) return true;
  recentNotifications.set(taskId, now);
  return false;
}
