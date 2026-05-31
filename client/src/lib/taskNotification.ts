export const TASK_CREATED_EVENT = 'bees:task-created';

export interface TaskCreatedNotificationDetail {
  title: string;
  taskId?: string;
}

let audioContext: AudioContext | null = null;
const recentNotifications = new Map<string, number>();

export function announceTaskCreated(title = 'Task created', taskId?: string): void {
  if (taskId && wasRecentlyAnnounced(taskId)) return;

  window.dispatchEvent(new CustomEvent<TaskCreatedNotificationDetail>(TASK_CREATED_EVENT, {
    detail: { title, taskId },
  }));
  playTaskCreatedSound();
}

export function primeTaskCreatedSound(): void {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'suspended') return;
  void ctx.resume().catch(() => {});
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
