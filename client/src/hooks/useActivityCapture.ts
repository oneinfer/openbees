import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { saveActivityTaskDraft } from '../lib/activityDraft';

interface ActivityEvent {
  id?: string;
  timestamp?: string;
  trigger?: string;
  spoken_input?: string;
  text?: {
    selection_text?: string;
    primary_selection_text?: string;
    clipboard_text?: string;
  };
  images?: {
    screenshot?: { path?: string } | null;
    cursor_crop?: { path?: string } | null;
  };
}

function isFreshEvent(event: ActivityEvent, connectedAt: number): boolean {
  if (!event.timestamp) return true;
  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) return true;
  return timestamp >= connectedAt - 2000;
}

export function useActivityCapture() {
  const navigate = useNavigate();
  const processedIds = useRef(new Set<string>());

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const connectedAt = Date.now();
      source = new EventSource('/api/activity/stream');

      source.onopen = () => {
        retryCount = 0;
      };

      source.addEventListener('snapshot', (message) => {
        try {
          const event = JSON.parse(message.data) as ActivityEvent;
          const id = event.id || `${event.timestamp ?? ''}:${event.trigger ?? ''}`;
          if (!id || processedIds.current.has(id)) return;
          if (event.trigger !== 'voice_selection' && event.trigger !== 'voice_screenshot') return;
          if (!isFreshEvent(event, connectedAt)) return;

          processedIds.current.add(id);
          const draft = activityTaskDraft(event, id);
          if (!draft.text && !draft.imagePath) return;

          saveActivityTaskDraft(draft);
          navigate(`/tasks/new?activityDraft=${encodeURIComponent(id)}`);
        } catch {
          // Ignore malformed activity snapshots; the stream will continue.
        }
      });

      source.onerror = () => {
        source?.close();
        const delay = Math.min(1000 * 2 ** retryCount, 30_000);
        retryCount += 1;
        retryTimeout = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimeout) clearTimeout(retryTimeout);
      source?.close();
    };
  }, [navigate]);
}

function activityTaskDraft(event: ActivityEvent, id: string) {
  const selectedText = event.trigger === 'voice_selection'
    ? (
        event.text?.selection_text?.trim()
        || event.text?.primary_selection_text?.trim()
        || event.text?.clipboard_text?.trim()
        || ''
      )
    : '';
  const spokenInput = event.spoken_input?.trim();
  const hasSpokenInput = Boolean(spokenInput && spokenInput !== '[input pending]');
  const imagePath = event.images?.screenshot?.path || event.images?.cursor_crop?.path || '';
  const textParts = [
    hasSpokenInput ? spokenInput : '',
    selectedText,
  ].filter(Boolean);

  return {
    id,
    trigger: event.trigger || 'activity',
    timestamp: event.timestamp,
    text: textParts.join('\n\n'),
    imagePath,
    imageName: imagePath ? imagePath.split(/[\\/]/).pop() || 'activity-screenshot.png' : undefined,
  };
}
