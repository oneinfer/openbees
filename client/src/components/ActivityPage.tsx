import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Loader2, Mic, Trash2 } from 'lucide-react';
import type { ActivityContext, BoardEvent } from '@shared/types';
import { deleteActivityContext, fetchActivityContexts, promoteActivityContext } from '../lib/api';
import { timeAgo, toErrorMessage } from '../lib/format';
import { useStore } from '../lib/store';

function imagePathFromContext(context: ActivityContext): string | null {
  const images = context.images;
  const screenshot = images?.screenshot;
  const cursorCrop = images?.cursor_crop;
  const selectionCrop = images?.selection_crop;
  for (const image of [screenshot, selectionCrop, cursorCrop]) {
    if (image && typeof image === 'object' && 'path' in image && typeof image.path === 'string') {
      return image.path;
    }
  }
  return null;
}

export function ActivityPage() {
  const navigate = useNavigate();
  const upsertTask = useStore((s) => s.upsertTask);
  const [contexts, setContexts] = useState<ActivityContext[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const sortedContexts = useMemo(
    () => [...contexts].sort((a, b) => b.created_at - a.created_at),
    [contexts],
  );

  useEffect(() => {
    fetchActivityContexts()
      .then((result) => setContexts(result.contexts))
      .catch((err) => setError(toErrorMessage(err, 'Failed to load activity inbox')))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as BoardEvent;
        if (event.type === 'activity_context_created') {
          setContexts((current) => [event.context, ...current.filter((context) => context.id !== event.context.id)]);
        } else if (event.type === 'activity_context_updated') {
          setContexts((current) => current.map((context) => context.id === event.context.id ? event.context : context));
        } else if (event.type === 'activity_context_deleted') {
          setContexts((current) => current.filter((context) => context.id !== event.contextId));
        }
      } catch {
        // Ignore malformed board events.
      }
    };
    return () => source.close();
  }, []);

  const handlePromote = useCallback(async (context: ActivityContext) => {
    if (busyId) return;
    setBusyId(context.id);
    setError(null);
    try {
      const result = await promoteActivityContext(context.id);
      upsertTask(result.task);
      setContexts((current) => current.map((item) => item.id === result.context.id ? result.context : item));
      navigate(`/tasks/${result.task.id}`);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to promote activity context'));
    } finally {
      setBusyId(null);
    }
  }, [busyId, navigate, upsertTask]);

  const handleDelete = useCallback(async (context: ActivityContext) => {
    if (busyId) return;
    setBusyId(context.id);
    setError(null);
    try {
      await deleteActivityContext(context.id);
      setContexts((current) => current.filter((item) => item.id !== context.id));
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to delete activity context'));
    } finally {
      setBusyId(null);
    }
  }, [busyId]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="flex h-48 items-center justify-center text-zinc-400">
            <Loader2 size={22} className="animate-spin" />
          </div>
        ) : sortedContexts.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center text-center text-sm text-zinc-400 dark:text-zinc-500">
            <Mic size={22} className="mb-2" />
            <p>No saved wake-word context yet.</p>
          </div>
        ) : (
          sortedContexts.map((context) => {
            const imagePath = imagePathFromContext(context);
            const isBusy = busyId === context.id;
            return (
              <article
                key={context.id}
                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
                      <span>{context.trigger.replace(/_/g, ' ')}</span>
                      <span>/</span>
                      <span>{timeAgo(context.created_at)}</span>
                      {context.promoted_task_id && (
                        <>
                          <span>/</span>
                          <span className="text-emerald-600 dark:text-emerald-400">Promoted</span>
                        </>
                      )}
                    </div>
                    <h2 className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {context.decision?.title || 'Saved voice context'}
                    </h2>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handlePromote(context)}
                      disabled={isBusy || Boolean(context.promoted_task_id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                    >
                      {isBusy ? <Loader2 size={13} className="animate-spin" /> : <ArrowUpRight size={13} />}
                      Promote
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(context)}
                      disabled={isBusy}
                      aria-label="Delete context"
                      title="Delete context"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-4 md:grid-cols-[1fr_180px]">
                  <div className="min-w-0 space-y-3 text-sm">
                    {context.spoken_input && (
                      <section>
                        <p className="text-xs font-medium uppercase text-zinc-400 dark:text-zinc-500">Transcript</p>
                        <p className="mt-1 whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">{context.spoken_input}</p>
                      </section>
                    )}
                    {context.captured_text && (
                      <section>
                        <p className="text-xs font-medium uppercase text-zinc-400 dark:text-zinc-500">Captured Text</p>
                        <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2 text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                          {context.captured_text}
                        </p>
                      </section>
                    )}
                    {context.decision?.reason && (
                      <section>
                        <p className="text-xs font-medium uppercase text-zinc-400 dark:text-zinc-500">Classifier Reason</p>
                        <p className="mt-1 text-zinc-600 dark:text-zinc-300">{context.decision.reason}</p>
                      </section>
                    )}
                  </div>
                  {imagePath && (
                    <img
                      src={`/api/files/view?path=${encodeURIComponent(imagePath)}`}
                      alt="Captured screen context"
                      className="h-32 w-full rounded-md border border-zinc-200 object-cover dark:border-zinc-800"
                    />
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
