import { v4 as uuid } from 'uuid';
import { broadcast } from './events.js';
import { applyEvent, broadcast as broadcastLive, finishRun, startRun } from './live-chat.js';
import { liveTts } from './tts/live-tts.js';
import { buildVoiceConversationSystemPrompt, buildVoiceTaskAckSystemPrompt } from './prompts/voice-assistant.js';
import { getActiveActivityAgentSettings } from './activity-agent-settings.js';
import type { StreamEvent } from './adapters/types.js';

const CONVERSATION_TTL_MS = 30_000;

export async function speakTaskAcknowledgment(taskId: string, title: string, description: string | null): Promise<void> {
  // Fire-and-forget from the caller (runs in parallel with task execution starting) — every
  // path here must resolve, never reject, or an unhandled rejection takes down the whole server
  // (no global unhandledRejection handler exists, and Node terminates on one by default).
  const fallback = `Got it, I'm starting on: ${title}.`;
  let ackText = fallback;

  try {
    const activeSettings = getActiveActivityAgentSettings();
    const { agents } = await import('./app.js');
    const adapter = agents.adapterFor(activeSettings.runtime);
    const sessionId = `bees-voice-ack-${uuid()}`;
    const prompt = `Task title: ${title}\nTask description: ${description ?? ''}`.trim();
    const result = await adapter.chat(sessionId, prompt, {
      systemMessage: buildVoiceTaskAckSystemPrompt(),
      settings: {
        runtime: activeSettings.runtime,
        model: activeSettings.model,
        reasoningEffort: activeSettings.reasoningEffort,
      },
    });
    ackText = result.text.trim() || fallback;
  } catch (error) {
    console.error('[voice-assistant] task acknowledgment generation failed, using fallback text:', error);
    ackText = fallback;
  }

  try {
    liveTts.acceptDelta(taskId, `${ackText} `, { forceFlush: true });
  } catch (error) {
    console.error('[voice-assistant] failed to speak task acknowledgment:', error);
  }
}

export async function runVoiceConversationTurn(transcript: string): Promise<void> {
  // Fire-and-forget from the caller — every path here must resolve, never reject (see the
  // note in speakTaskAcknowledgment above: an unhandled rejection here takes down the server).
  const sessionId = `bees-voice-chat-${uuid()}`;
  let sawDone = false;

  try {
    const activeSettings = getActiveActivityAgentSettings();

    liveTts.beginSession(sessionId);
    const run = startRun(sessionId, sessionId, transcript);
    broadcast({ type: 'voice_conversation_reply', sessionId, transcript });

    try {
      const { agents } = await import('./app.js');
      const adapter = agents.adapterFor(activeSettings.runtime);
      const stream = adapter.chatStream(sessionId, transcript, {
        systemMessage: buildVoiceConversationSystemPrompt(),
        settings: {
          runtime: activeSettings.runtime,
          model: activeSettings.model,
          reasoningEffort: activeSettings.reasoningEffort,
        },
      });
      for await (const event of stream) {
        if (event.type === 'text_delta') liveTts.acceptDelta(sessionId, event.content ?? '');
        if (event.type === 'done') {
          sawDone = true;
          liveTts.end(sessionId);
        }
        applyEvent(sessionId, event);
        broadcastLive(sessionId, event);
      }
    } catch (error) {
      const errorEvent: StreamEvent = { type: 'error', error: error instanceof Error ? error.message : String(error) };
      applyEvent(sessionId, errorEvent);
      broadcastLive(sessionId, errorEvent);
      liveTts.end(sessionId);
    } finally {
      if (!sawDone) {
        const doneEvent: StreamEvent = { type: 'done', sessionId };
        applyEvent(sessionId, doneEvent);
        broadcastLive(sessionId, doneEvent);
        liveTts.end(sessionId);
      }
      finishRun(sessionId, CONVERSATION_TTL_MS, run.runId);
    }
  } catch (error) {
    console.error('[voice-assistant] voice conversation turn failed:', error);
  }
}
