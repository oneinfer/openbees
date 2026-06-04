export const TASK_CREATED_EVENT = 'bees:task-created';

export interface TaskCreatedNotificationDetail {
  title: string;
  taskId?: string;
}

const TASK_NOTIFICATIONS_ENABLED_KEY = 'bees:taskNotificationsEnabled';
const TASK_NOTIFICATION_PREFERENCE_EVENT = 'bees:task-notification-preference';

let audioContext: AudioContext | null = null;
let notificationPermissionRequest: Promise<NotificationPermission> | null = null;
const recentNotifications = new Map<string, number>();

export function announceTaskCreated(title = 'Task created', taskId?: string): void {
  if (taskId && wasRecentlyAnnounced(taskId)) return;

  window.dispatchEvent(new CustomEvent<TaskCreatedNotificationDetail>(TASK_CREATED_EVENT, {
    detail: { title, taskId },
  }));
  playTaskCreatedSound();
  showTaskCreatedSystemNotification(title, taskId);
}

export function primeTaskCreatedSound(): void {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'suspended') return;
  void ctx.resume().catch(() => {});
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

function playTaskCreatedSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.setValueAtTime(660, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.2);
  } catch {
    // Browsers may block audio until a user gesture. The visual toast still appears.
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

function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;

  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  try {
    audioContext = new AudioContextCtor();
    return audioContext;
  } catch {
    return null;
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

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
