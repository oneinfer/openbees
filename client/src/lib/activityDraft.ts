import type { ActivityContext } from '@shared/types';

export interface ActivityTaskDraft {
  id: string;
  trigger: string;
  timestamp?: string;
  spokenInput?: string;
  text?: string;
  imagePath?: string;
  imageName?: string;
  imageBase64?: string;
  imageMimeType?: string;
}

const ACTIVITY_TASK_DRAFT_KEY = 'bees:activityTaskDraft';

export function saveActivityTaskDraft(draft: ActivityTaskDraft): void {
  try {
    sessionStorage.setItem(ACTIVITY_TASK_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    const { imageBase64, ...withoutEmbeddedImage } = draft;
    sessionStorage.setItem(ACTIVITY_TASK_DRAFT_KEY, JSON.stringify(withoutEmbeddedImage));
  }
}

export function loadActivityTaskDraft(id?: string | null): ActivityTaskDraft | null {
  const raw = sessionStorage.getItem(ACTIVITY_TASK_DRAFT_KEY);
  if (!raw) return null;

  try {
    const draft = JSON.parse(raw) as ActivityTaskDraft;
    if (id && draft.id !== id) return null;
    return draft;
  } catch {
    return null;
  }
}

export function clearActivityTaskDraft(id?: string | null): void {
  if (!id) {
    sessionStorage.removeItem(ACTIVITY_TASK_DRAFT_KEY);
    return;
  }

  const draft = loadActivityTaskDraft();
  if (!draft || draft.id === id) sessionStorage.removeItem(ACTIVITY_TASK_DRAFT_KEY);
}

export function createActivityTaskDraft(context: ActivityContext): ActivityTaskDraft | null {
  const text = buildActivityDraftText(context);
  const image = imageFromContext(context);
  if (!text && !image?.path && !image?.base64) return null;

  return {
    id: context.id,
    trigger: context.trigger,
    timestamp: new Date(context.created_at).toISOString(),
    spokenInput: context.spoken_input ?? undefined,
    text,
    imagePath: image?.path ?? undefined,
    imageName: image?.path ? image.path.split(/[\\/]/).pop() || 'activity-screenshot.png' : undefined,
    imageBase64: image?.base64 ?? undefined,
    imageMimeType: image?.mimeType ?? undefined,
  };
}

function buildActivityDraftText(context: ActivityContext): string {
  const taskText = normalizeSpokenInput(context.spoken_input);
  const pieces = [
    taskText || null,
    context.captured_text?.trim() || null,
  ].filter((piece): piece is string => Boolean(piece));

  return [...new Set(pieces)].join('\n\n');
}

function normalizeSpokenInput(value: string | null): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '[input pending]' ? '' : trimmed;
}

function imageFromContext(context: ActivityContext): { path?: string; base64?: string; mimeType?: string } | null {
  const images = context.images;
  const screenshot = images?.screenshot;
  const selectionCrop = images?.selection_crop;
  const cursorCrop = images?.cursor_crop;
  for (const image of [screenshot, selectionCrop, cursorCrop]) {
    if (!image || typeof image !== 'object') continue;
    const record = image as Record<string, unknown>;
    const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
    const rawBase64 = typeof record.base64 === 'string' && record.base64.trim() ? record.base64.trim() : undefined;
    const dataUrlMatch = rawBase64?.match(/^data:([^;,]+);base64,(.+)$/);
    const base64 = dataUrlMatch ? dataUrlMatch[2] : rawBase64;
    const mimeType = dataUrlMatch?.[1]
      || (typeof record.mimeType === 'string' && record.mimeType.trim())
      || (typeof record.mime_type === 'string' && record.mime_type.trim())
      || (path ? mimeTypeForPath(path) : undefined);
    if (path || base64) {
      return { path, base64, mimeType };
    }
  }
  return null;
}

function mimeTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}
