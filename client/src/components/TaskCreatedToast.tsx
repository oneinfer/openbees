import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { TASK_CREATED_EVENT, type TaskCreatedNotificationDetail } from '../lib/taskNotification';

export function TaskCreatedToast() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function handleTaskCreated(event: Event) {
      const detail = (event as CustomEvent<TaskCreatedNotificationDetail>).detail;
      setMessage(detail?.title || 'Task created');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMessage(null), 2600);
    }

    window.addEventListener(TASK_CREATED_EVENT, handleTaskCreated);
    return () => {
      window.removeEventListener(TASK_CREATED_EVENT, handleTaskCreated);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 inline-flex max-w-sm items-center gap-2 rounded-xl border border-emerald-200 bg-white px-4 py-3 text-sm font-medium text-zinc-900 shadow-lg dark:border-emerald-900/60 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <CheckCircle2 size={17} className="shrink-0 text-emerald-500" />
      <span className="truncate">{message}</span>
    </div>
  );
}
