export interface ActivityTaskDraft {
  id: string;
  trigger: string;
  timestamp?: string;
  text?: string;
  imagePath?: string;
  imageName?: string;
}

const ACTIVITY_TASK_DRAFT_KEY = 'bees:activityTaskDraft';

export function saveActivityTaskDraft(draft: ActivityTaskDraft): void {
  sessionStorage.setItem(ACTIVITY_TASK_DRAFT_KEY, JSON.stringify(draft));
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
