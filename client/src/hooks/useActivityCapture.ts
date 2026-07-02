import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { BoardEvent } from '@shared/types';
import { createActivityTaskDraft, saveActivityTaskDraft } from '../lib/activityDraft';
import { useStore } from '../lib/store';
import { playWakeAck, subscribeVoiceConversation, subscribeVoiceTask } from '../lib/voiceAssistantAudio';

export function useActivityCapture() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const handledContextIds = useRef(new Set<string>());
  const retryRef = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      source = new EventSource('/api/events');

      source.onopen = () => {
        retryRef.current = 0;
      };

      source.onmessage = (message) => {
        handleBoardEvent(message);
      };

      source.onerror = () => {
        source?.close();
        const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
        retryRef.current += 1;
        retryTimeout = setTimeout(connect, delay);
      };
    }

    function handleBoardEvent(message: MessageEvent<string>) {
      try {
        const event = JSON.parse(message.data) as BoardEvent;
        if (event.type === 'voice_wake_ack') {
          void playWakeAck();
          return;
        }
        if (event.type === 'voice_task_started') {
          subscribeVoiceTask(event.taskId);
          return;
        }
        if (event.type === 'voice_conversation_reply') {
          subscribeVoiceConversation(event.sessionId);
          return;
        }
        if (event.type !== 'activity_draft_created') return;
        if (event.context.promoted_task_id) return;
        if (handledContextIds.current.has(event.context.id)) return;

        const draft = createActivityTaskDraft(event.context);
        if (!draft) return;

        handledContextIds.current.add(event.context.id);
        saveActivityTaskDraft(draft);
        const params = new URLSearchParams({ activityDraft: draft.id });
        const workspacePath = routeWorkspacePath(location.pathname, location.search) || currentProjectPath;
        if (workspacePath) params.set('workspacePath', workspacePath);

        navigate(`/tasks/new?${params.toString()}`, {
          replace: location.pathname === '/tasks/new',
        });
      } catch {
        // Ignore malformed board events.
      }
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      source?.close();
    };
  }, [currentProjectPath, location.pathname, location.search, navigate]);
}

function routeWorkspacePath(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  const routePath = pathname === '/projects'
    ? params.get('path')
    : pathname === '/tasks/new'
      ? params.get('workspacePath')
      : null;
  const normalized = routePath?.trim();
  return normalized || null;
}
