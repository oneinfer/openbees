import type { ActivityIntentDecision } from '../../shared/types.js';

export const ACTIVITY_INTENT_SYSTEM_PROMPT = `You are a wake-word activity intent classifier for Bees.
Respond ONLY with one JSON object and no markdown.
Do not use tools.

Rules:
- Decide from the spoken input plus any captured selected text, active-window metadata, and captured image metadata supplied by the user message.
- Treat selected text, active-window metadata, and captured image file metadata as context the task agent can use.
- Image metadata proves a screenshot or crop exists. You cannot inspect the pixels in this classifier, so do not invent visual details.
- Decide whether screen/image context is required for the task. Set screenContextRequired=true only when the task depends on visible screen content, selected text, a screenshot/crop, or phrases like "this", "like this", "on screen", "visible", or "selected".
- Set screenContextRequired=false for self-contained requests such as coding, writing, search, or explanation tasks where the transcript alone is enough.
- A captured screenshot/crop IS enough context when the spoken input asks to create, build, design, clone, recreate, implement, or modify something "like this" or based on the visible reference. In that case return create_task, set screenContextRequired=true, and tell the task agent to inspect the captured image file.
- Return create_task only when the spoken input and captured context together define a clear actionable task with enough context to begin.
- Never return create_task for incomplete command fragments such as "can you", "could you", "please", "write", "explain", or "help" unless the transcript includes what the user wants done.
- Return save_context when the request is vague, conversational, missing the action, or has no usable spoken/captured context.
- If returning create_task, include only useful context in taskDescription. Mention captured image files only when screenContextRequired=true.

Schema:
{"action":"create_task"|"save_context","title":"short title","taskDescription":"task prompt based on spoken input and captured context","hasEnoughContext":true|false,"screenContextRequired":true|false,"reason":"one sentence"}`;

export function buildActivityIntentRequest(input: {
  transcript: string;
  timestamp?: string | null;
  source?: string | null;
  capturedText?: string | null;
  activeWindow?: Record<string, unknown> | null;
  images?: Record<string, unknown> | null;
}): string {
  const metadata = [
    input.timestamp ? `timestamp: ${input.timestamp}` : null,
    input.source ? `source: ${input.source}` : null,
  ].filter(Boolean).join('\n');
  const context = [
    input.capturedText?.trim() ? `Captured selected text:\n${input.capturedText.trim()}` : null,
    input.activeWindow ? `Active window:\n${JSON.stringify(input.activeWindow, null, 2)}` : null,
    input.images ? `Captured image metadata:\n${JSON.stringify(input.images, null, 2)}` : null,
  ].filter(Boolean).join('\n\n');

  return `${metadata ? `Metadata:\n${metadata}\n\n` : ''}Transcript:
${input.transcript || '[none]'}

${context ? `Captured context:\n${context}\n\n` : ''}Classify whether this wake-word event is enough to create and start an autonomous task.`;
}

export function normalizeActivityIntentDecision(
  value: Partial<ActivityIntentDecision> | null | undefined,
  transcript: string,
): ActivityIntentDecision {
  const action = value?.action === 'create_task' && value.hasEnoughContext === true ? 'create_task' : 'save_context';
  const title = typeof value?.title === 'string' && value.title.trim()
    ? value.title.trim().slice(0, 80)
    : (action === 'create_task' ? transcript.trim().slice(0, 80) || 'Voice task' : 'Saved voice context');
  const fallbackDescription = transcript.trim();
  const taskDescription = action === 'create_task' && typeof value?.taskDescription === 'string' && value.taskDescription.trim()
    ? value.taskDescription.trim()
    : fallbackDescription;
  const reason = typeof value?.reason === 'string' && value.reason.trim()
    ? value.reason.trim()
    : (action === 'create_task' ? 'Transcript contains an actionable task.' : 'Transcript does not contain enough task context.');
  const screenContextRequired = value?.screenContextRequired === true;

  return {
    action,
    title,
    taskDescription,
    hasEnoughContext: action === 'create_task',
    screenContextRequired,
    reason,
  };
}
