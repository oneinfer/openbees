import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowUp, FolderOpen, Loader2, MessageSquare, Trash2, X } from 'lucide-react';
import {
  AttachmentPicker,
  AttachmentPreviewList,
  composerAttachmentsFromClipboard,
  type ComposerAttachment,
} from './AttachmentPicker';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { InputToolbar } from './InputToolbar';
import { TaskChat } from './TaskChat';
import { createTask, deleteTask, markTaskViewed, moveTask, pickWorkspaceDirectory } from '../lib/api';
import { handleChatKeyDown } from '../lib/keyboard';
import { getProjectLabel } from '../lib/projects';
import { useStore } from '../lib/store';
import { isChatTask } from '../lib/taskState';
import { toErrorMessage } from '../lib/format';
import { useAgentConfig } from '../hooks/useAgentConfig';

const CHAT_COLUMN_CLASS = 'w-full max-w-[760px] mx-auto';
const CHAT_WORKSPACE_STORAGE_KEY = 'bees:lastChatWorkspacePath';

function NewChatComposer() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialMessage = searchParams.get('msg') ?? '';
  const [input, setInput] = useState(initialMessage);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [workspacePath, setWorkspacePath] = useState(() => localStorage.getItem(CHAT_WORKSPACE_STORAGE_KEY) ?? '');
  const [isCreating, setIsCreating] = useState(false);
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const upsertTask = useStore((s) => s.upsertTask);
  const {
    defaults,
    runtimeOptions,
    runtime,
    setRuntime,
    modelGroups,
    runtimeDefaultModel,
    model,
    setModel,
    reasoningEffort,
    setReasoningEffort,
    isLoading,
  } = useAgentConfig();

  const normalizedWorkspacePath = workspacePath.trim();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!initialMessage) return;
    navigate('/chats', { replace: true });
  }, [initialMessage, navigate]);

  const cleanupAttachmentPreviews = useCallback(() => {
    for (const attachment of attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
  }, [attachments]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isCreating || (!defaults && isLoading)) return;

    setIsCreating(true);
    setError(null);
    try {
      const files = attachments.map((attachment) => attachment.file);
      const { task } = await createTask(
        text,
        undefined,
        normalizedWorkspacePath || null,
        runtime,
        model,
        reasoningEffort,
        'direct',
        files,
        'chat',
      );
      upsertTask(task);

      const { task: startedTask } = await moveTask(task.id, 'in_progress');
      upsertTask(startedTask);

      if (normalizedWorkspacePath) localStorage.setItem(CHAT_WORKSPACE_STORAGE_KEY, normalizedWorkspacePath);
      else localStorage.removeItem(CHAT_WORKSPACE_STORAGE_KEY);

      cleanupAttachmentPreviews();
      setInput('');
      setAttachments([]);
      navigate(`/chats/${startedTask.id}`, { replace: true });
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to start chat'));
      setIsCreating(false);
    }
  }, [
    attachments,
    cleanupAttachmentPreviews,
    defaults,
    input,
    isCreating,
    isLoading,
    model,
    navigate,
    normalizedWorkspacePath,
    reasoningEffort,
    runtime,
    upsertTask,
  ]);

  const handleChooseWorkspace = useCallback(async () => {
    if (isPickingWorkspace || isCreating) return;
    setIsPickingWorkspace(true);
    setError(null);

    try {
      const result = await pickWorkspaceDirectory(normalizedWorkspacePath || null);
      if (result.path) setWorkspacePath(result.path);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to open folder picker'));
    } finally {
      setIsPickingWorkspace(false);
    }
  }, [isCreating, isPickingWorkspace, normalizedWorkspacePath]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isCreating) return;

    const pastedAttachments = composerAttachmentsFromClipboard(event);
    if (pastedAttachments.length === 0) return;

    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    setAttachments((current) => [...current, ...pastedAttachments]);
  }, [isCreating]);

  return (
    <div className="flex-1 flex flex-col items-center justify-end px-4 sm:px-6 pb-16">
      <div className={`${CHAT_COLUMN_CLASS} mb-6 flex flex-col items-center text-center`}>
        <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-200 bg-white text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
          <MessageSquare size={20} />
        </div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          What can I help you with?
        </h1>
        {normalizedWorkspacePath && (
          <p className="mt-2 max-w-full truncate text-xs text-zinc-400 dark:text-zinc-500">
            Using {getProjectLabel(normalizedWorkspacePath)}
          </p>
        )}
      </div>

      <div className={CHAT_COLUMN_CLASS}>
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
          {normalizedWorkspacePath && (
            <div className="border-b border-zinc-100 bg-zinc-50/70 px-5 py-3 dark:border-zinc-700/70 dark:bg-zinc-900/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                    Working directory
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-200" title={normalizedWorkspacePath}>
                    {normalizedWorkspacePath}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setWorkspacePath('')}
                  disabled={isCreating || isPickingWorkspace}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200"
                  aria-label="Clear working directory"
                  title="Clear working directory"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
          <AttachmentPreviewList
            attachments={attachments}
            disabled={isCreating}
            onChange={setAttachments}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask, brainstorm, or point me at a repo to work through..."
            rows={4}
            disabled={isCreating}
            className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm leading-relaxed text-zinc-900 placeholder-zinc-400 focus:outline-none disabled:cursor-not-allowed dark:text-zinc-100 dark:placeholder-zinc-500"
          />
          <div className="flex items-center justify-between gap-3 px-4 pb-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <AttachmentPicker
                attachments={attachments}
                disabled={isCreating}
                onChange={setAttachments}
              />
              <InputToolbar
                runtime={runtime}
                model={model}
                reasoningEffort={reasoningEffort}
                defaults={defaults}
                runtimeDefaultModel={runtimeDefaultModel}
                runtimeOptions={runtimeOptions}
                modelGroups={modelGroups}
                disabled={isCreating}
                onRuntimeChange={setRuntime}
                onModelChange={setModel}
                onReasoningEffortChange={setReasoningEffort}
              />
              <button
                type="button"
                onClick={handleChooseWorkspace}
                disabled={isCreating || isPickingWorkspace}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70"
              >
                {isPickingWorkspace ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
                <span>Choose Folder</span>
              </button>
            </div>
            <button
              onClick={handleSubmit}
              disabled={!input.trim() || isCreating || (!defaults && isLoading)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:opacity-30 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              aria-label="Send message"
              title="Send message"
            >
              {isCreating ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
            </button>
          </div>
          {error && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExistingChatPage({ chatId }: { chatId: string }) {
  const navigate = useNavigate();
  const task = useStore((s) => s.tasks.find((t) => t.id === chatId) ?? null);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const markViewedInFlightRef = useRef<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!task || task.last_agent_response_at === null) return;
    if (task.last_viewed_at !== null && task.last_viewed_at >= task.last_agent_response_at) return;

    const key = `${task.id}:${task.last_agent_response_at}`;
    if (markViewedInFlightRef.current === key) return;
    markViewedInFlightRef.current = key;

    markTaskViewed(task.id)
      .then(({ task: updated }) => upsertTask(updated))
      .catch(() => {})
      .finally(() => {
        if (markViewedInFlightRef.current === key) markViewedInFlightRef.current = null;
      });
  }, [task?.id, task?.last_agent_response_at, task?.last_viewed_at, upsertTask]);

  const handleDelete = useCallback(async () => {
    if (!task || isDeleting) return;

    setIsDeleting(true);
    setDeleteError(null);
    try {
      await deleteTask(task.id);
      removeTask(task.id);
      navigate('/chats', { replace: true });
    } catch (err) {
      setDeleteError(toErrorMessage(err, 'Failed to delete chat'));
      setIsDeleting(false);
    }
  }, [isDeleting, navigate, removeTask, task]);

  if (!task) {
    if (!tasksLoaded) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-zinc-400" />
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-400 dark:text-zinc-500">Chat not found</p>
      </div>
    );
  }

  if (!isChatTask(task)) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-400 dark:text-zinc-500">This thread is a task, not a chat.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-4 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800 sm:px-6">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <MessageSquare size={16} className="shrink-0 text-zinc-400 dark:text-zinc-500" />
            <h1 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {task.title}
            </h1>
          </div>
          {task.workspace_path && (
            <p className="mt-1 truncate text-xs text-zinc-400 dark:text-zinc-500">
              {getProjectLabel(task.workspace_path)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setDeleteError(null);
            setShowDeleteConfirm(true);
          }}
          disabled={isDeleting}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
          aria-label="Delete chat"
          title="Delete chat"
        >
          {isDeleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
        </button>
      </div>
      <TaskChat
        taskId={task.id}
        taskStatus={task.status}
        emptyMessage="Continue the conversation with your assistant."
        inputPlaceholder="Message your assistant..."
        workspacePath={task.workspace_path}
      />
      {showDeleteConfirm && (
        <DeleteConfirmModal
          title="Delete chat"
          body="This removes the chat from Bees. The Hermes session history remains in Hermes."
          confirmLabel="Delete chat"
          isConfirming={isDeleting}
          error={deleteError}
          onConfirm={handleDelete}
          onCancel={() => {
            if (isDeleting) return;
            setShowDeleteConfirm(false);
            setDeleteError(null);
          }}
        />
      )}
    </div>
  );
}

export function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  return chatId ? <ExistingChatPage chatId={chatId} /> : <NewChatComposer />;
}
