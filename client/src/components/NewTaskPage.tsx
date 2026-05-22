import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, FolderOpen, GitBranch, Loader2, X } from 'lucide-react';
import { InputToolbar } from './InputToolbar';
import {
  AttachmentPicker,
  AttachmentPreviewList,
  composerAttachmentsFromClipboard,
  type ComposerAttachment,
} from './AttachmentPicker';
import { createTask, pickWorkspaceDirectory } from '../lib/api';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { isEditableTarget, handleChatKeyDown } from '../lib/keyboard';
import { toErrorMessage } from '../lib/format';
import { projectHref } from '../lib/projects';

export function NewTaskPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedWorkspacePath = searchParams.get('workspacePath')?.trim() ?? '';
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [workspacePath, setWorkspacePath] = useState(() => {
    if (requestedWorkspacePath) return requestedWorkspacePath;
    return localStorage.getItem('minions:lastWorkspacePath') ?? '';
  });
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const { defaults, runtimeOptions, runtime, setRuntime, modelGroups, runtimeDefaultModel, model, setModel, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const normalizedWorkspacePath = workspacePath.trim();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!requestedWorkspacePath) return;
    setWorkspacePath(requestedWorkspacePath);
    setWorkspaceError(null);
  }, [requestedWorkspacePath]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e)) navigate('/');
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const files = attachments.map((attachment) => attachment.file);
    if ((!text && files.length === 0) || isCreating || (!defaults && isLoading)) return;
    setIsCreating(true);
    setWorkspaceError(null);
    try {
      await createTask(
        text || (files.length === 1 ? 'Attached file.' : 'Attached files.'),
        undefined,
        normalizedWorkspacePath || null,
        runtime,
        model,
        reasoningEffort,
        planModeEnabled ? 'plan' : 'direct',
        files,
      );
      if (normalizedWorkspacePath) localStorage.setItem('minions:lastWorkspacePath', normalizedWorkspacePath);
      else localStorage.removeItem('minions:lastWorkspacePath');
      navigate(normalizedWorkspacePath ? projectHref(normalizedWorkspacePath) : '/');
    } catch (error) {
      setWorkspaceError(toErrorMessage(error, 'Failed to create task'));
      setIsCreating(false);
    }
  }, [attachments, defaults, input, isCreating, isLoading, model, navigate, normalizedWorkspacePath, planModeEnabled, reasoningEffort, runtime]);

  const handleChooseWorkspace = useCallback(async () => {
    if (isPickingWorkspace || isCreating) return;
    setIsPickingWorkspace(true);
    setWorkspaceError(null);

    try {
      const result = await pickWorkspaceDirectory(normalizedWorkspacePath || null);
      if (result.path) setWorkspacePath(result.path);
    } catch (error) {
      setWorkspaceError(toErrorMessage(error, 'Failed to open folder picker'));
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
    <div className="flex-1 flex flex-col items-center justify-end px-6 pb-16">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6">
        What do you need done?
      </h1>

      <div className="w-full max-w-4xl">
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-sm overflow-hidden">
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
                  onClick={() => {
                    setWorkspacePath('');
                    setWorkspaceError(null);
                  }}
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
            placeholder="Describe your task in detail..."
            rows={4}
            className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed"
          />
          <div className="flex items-center justify-between gap-3 px-4 pb-3">
            <div className="flex min-w-0 items-center gap-2 flex-wrap">
              <AttachmentPicker
                attachments={attachments}
                disabled={isCreating}
                onChange={setAttachments}
              />
              <button
                type="button"
                onClick={() => setPlanModeEnabled((current) => !current)}
                disabled={isCreating}
                aria-pressed={planModeEnabled}
                title={planModeEnabled ? 'Disable plan mode' : 'Enable plan mode'}
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  planModeEnabled
                    ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300 dark:hover:bg-amber-900/40'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70'
                }`}
              >
                <GitBranch size={12} className="shrink-0" />
                <span>Plan mode</span>
              </button>
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
              disabled={(!input.trim() && attachments.length === 0) || isCreating || (!defaults && isLoading)}
              className="p-2.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
            >
              {isCreating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <ArrowUp size={16} />
              )}
            </button>
          </div>
          {workspaceError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">
                {workspaceError}
              </p>
            </div>
          )}
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mt-3">
          {planModeEnabled
            ? 'Plan mode writes the plan first, keeps the task in Pending, and waits for you to move it to In Progress before execution.'
            : 'The more context you give, the better your assistant will do.'}
        </p>
      </div>
    </div>
  );
}
