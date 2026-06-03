import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUp, FolderOpen, GitBranch, Loader2, X } from 'lucide-react';
import { InputToolbar } from './InputToolbar';
import { VoiceInputButton } from './VoiceInputButton';
import {
  AttachmentPicker,
  AttachmentPreviewList,
  composerAttachmentsFromClipboard,
  createComposerAttachments,
  type ComposerAttachment,
} from './AttachmentPicker';
import { ActivityCaptureButton } from './ActivityCaptureButton';
import { createTask, pickWorkspaceDirectory, transcribeTaskIntentAudio, updateCurrentProject } from '../lib/api';
import { clearActivityTaskDraft, loadActivityTaskDraft } from '../lib/activityDraft';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { isEditableTarget, handleChatKeyDown } from '../lib/keyboard';
import { toErrorMessage } from '../lib/format';
import { useStore } from '../lib/store';
import { announceTaskCreated, primeTaskCreatedNotifications, primeTaskCreatedSound } from '../lib/taskNotification';

export function NewTaskPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedWorkspacePath = searchParams.get('workspacePath')?.trim() ?? '';
  const activityDraftId = searchParams.get('activityDraft');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [workspacePath, setWorkspacePath] = useState(() => {
    if (requestedWorkspacePath) return requestedWorkspacePath;
    return localStorage.getItem('bees:lastWorkspacePath') ?? '';
  });
  const [planModeEnabled, setPlanModeEnabled] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceIntentMessage, setVoiceIntentMessage] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [isApplyingActivityDraft, setIsApplyingActivityDraft] = useState(false);
  const [activityCaptureMessage, setActivityCaptureMessage] = useState<string | null>(null);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const upsertProject = useStore((s) => s.upsertProject);
  const { defaults, runtimeOptions, runtime, setRuntime, modelGroups, runtimeDefaultModel, model, setModel, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const workspaceEditedRef = useRef(false);
  const normalizedWorkspacePath = workspacePath.trim();

  const updateWorkspaceSearchParam = useCallback((path: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (path?.trim()) next.set('workspacePath', path.trim());
    else next.delete('workspacePath');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const rememberWorkspacePath = useCallback((path: string | null) => {
    const normalized = path?.trim() || null;
    setCurrentProjectPath(normalized);
    void updateCurrentProject(normalized)
      .then((current) => {
        if (current.project) upsertProject(current.project);
      })
      .catch(console.error);
  }, [setCurrentProjectPath, upsertProject]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!activityDraftId) return;
    const draft = loadActivityTaskDraft(activityDraftId);
    if (!draft) return;
    let cancelled = false;
    setIsApplyingActivityDraft(true);
    setActivityCaptureMessage('Captured context loaded.');

    if (draft.text?.trim()) {
      setInput((current) => {
        const text = draft.text?.trim() ?? '';
        if (!current.trim()) return text;
        if (current.includes(text)) return current;
        return `${current.trimEnd()}\n\n${text}`;
      });
    }

    void (async () => {
      if (draft.imagePath || draft.imageBase64) {
        const file = await loadActivityScreenshot(
          draft.imagePath,
          draft.imageName,
          draft.imageBase64,
          draft.imageMimeType,
        );
        if (!cancelled && file) {
          setAttachments((current) => [...current, ...createComposerAttachments([file])]);
        }
      }

      if (cancelled) return;
      clearActivityTaskDraft(draft.id);
      setIsApplyingActivityDraft(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [activityDraftId]);

  useEffect(() => {
    if (!requestedWorkspacePath) return;
    workspaceEditedRef.current = false;
    setWorkspacePath(requestedWorkspacePath);
    rememberWorkspacePath(requestedWorkspacePath);
    setWorkspaceError(null);
  }, [rememberWorkspacePath, requestedWorkspacePath]);

  useEffect(() => {
    if (requestedWorkspacePath || workspaceEditedRef.current || !currentProjectPath) return;
    if (workspacePath.trim() === currentProjectPath) return;
    setWorkspacePath(currentProjectPath);
  }, [currentProjectPath, requestedWorkspacePath, workspacePath]);

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
    primeTaskCreatedSound();
    primeTaskCreatedNotifications();
    setIsCreating(true);
    setWorkspaceError(null);
    try {
      const created = await createTask(
        text || (files.length === 1 ? 'Attached file.' : 'Attached files.'),
        undefined,
        normalizedWorkspacePath || null,
        runtime,
        model,
        reasoningEffort,
        planModeEnabled ? 'plan' : 'direct',
        files,
        'task',
        true,
      );
      const task = created.task;
      announceTaskCreated(`Task has been created and started in In Progress: ${task.title}`, task.id);
      if (normalizedWorkspacePath) {
        setCurrentProjectPath(normalizedWorkspacePath);
        void updateCurrentProject(normalizedWorkspacePath)
          .then((result) => {
            if (result.project) upsertProject(result.project);
          })
          .catch(console.error);
      }
      navigate(`/tasks/${task.id}`);
    } catch (error) {
      setWorkspaceError(toErrorMessage(error, 'Failed to create task'));
      setIsCreating(false);
    }
  }, [attachments, defaults, input, isCreating, isLoading, model, navigate, normalizedWorkspacePath, planModeEnabled, reasoningEffort, runtime, setCurrentProjectPath, upsertProject]);

  const handleChooseWorkspace = useCallback(async () => {
    if (isPickingWorkspace || isCreating) return;
    setIsPickingWorkspace(true);
    setWorkspaceError(null);

    try {
      const result = await pickWorkspaceDirectory(normalizedWorkspacePath || null);
      if (result.path) {
        workspaceEditedRef.current = true;
        setWorkspacePath(result.path);
        updateWorkspaceSearchParam(result.path);
        rememberWorkspacePath(result.path);
      }
    } catch (error) {
      setWorkspaceError(toErrorMessage(error, 'Failed to open folder picker'));
    } finally {
      setIsPickingWorkspace(false);
    }
  }, [isCreating, isPickingWorkspace, normalizedWorkspacePath, rememberWorkspacePath, updateWorkspaceSearchParam]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  const handleFormSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleSubmit();
  }, [handleSubmit]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isCreating) return;

    const pastedAttachments = composerAttachmentsFromClipboard(event);
    if (pastedAttachments.length === 0) return;

    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    setAttachments((current) => [...current, ...pastedAttachments]);
  }, [isCreating]);

  const handleVoiceTranscript = useCallback((text: string) => {
    const target = inputRef.current;
    const start = target?.selectionStart ?? input.length;
    const end = target?.selectionEnd ?? input.length;
    const prefix = input.slice(0, start);
    const suffix = input.slice(end);
    const before = prefix && !/\s$/.test(prefix) ? ' ' : '';
    const after = suffix && !/^\s/.test(suffix) ? ' ' : '';
    const next = `${prefix}${before}${text}${after}${suffix}`;
    const cursor = prefix.length + before.length + text.length + after.length;

    setInput(next);
    setVoiceError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  }, [input]);

  const handleVoiceTaskIntent = useCallback(async (audio: Blob) => {
    if (isCreating || (!defaults && isLoading)) return;

    primeTaskCreatedSound();
    primeTaskCreatedNotifications();
    setIsCreating(true);
    setWorkspaceError(null);
    setVoiceError(null);
    setVoiceIntentMessage('Deciding whether to start a task...');

    try {
      const result = await transcribeTaskIntentAudio(audio, {
        workspacePath: normalizedWorkspacePath || null,
        runtime,
        model,
        reasoningEffort,
        taskMode: planModeEnabled ? 'plan' : 'direct',
      });

      if (result.actionTaken === 'task_created_started' && result.task) {
        const task = result.task;
        announceTaskCreated(`Task has been created and started in In Progress: ${task.title}`, task.id);
        if (normalizedWorkspacePath) {
          setCurrentProjectPath(normalizedWorkspacePath);
          void updateCurrentProject(normalizedWorkspacePath)
            .then((current) => {
              if (current.project) upsertProject(current.project);
            })
            .catch(console.error);
        }
        navigate(`/tasks/${task.id}`);
        return;
      }

      if (result.transcript.text.trim()) {
        handleVoiceTranscript(result.transcript.text);
      }
      setVoiceError(result.decision.reason || result.error || 'Review the transcript and submit manually.');
    } catch (error) {
      setVoiceError(toErrorMessage(error, 'Failed to process voice task'));
    } finally {
      setVoiceIntentMessage(null);
      setIsCreating(false);
    }
  }, [
    defaults,
    handleVoiceTranscript,
    isCreating,
    isLoading,
    model,
    navigate,
    normalizedWorkspacePath,
    planModeEnabled,
    reasoningEffort,
    runtime,
    setCurrentProjectPath,
    upsertProject,
  ]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6">
        What do you need done?
      </h1>
      {activityCaptureMessage && (
        <div className="mb-4 w-full max-w-4xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          {activityCaptureMessage}
        </div>
      )}

      <form className="w-full max-w-4xl" onSubmit={handleFormSubmit}>
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
                    workspaceEditedRef.current = true;
                    setWorkspacePath('');
                    updateWorkspaceSearchParam(null);
                    rememberWorkspacePath(null);
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
              <ActivityCaptureButton
                disabled={isCreating}
                inputText={input}
                onCapture={(nextAttachments) => setAttachments((current) => [...current, ...nextAttachments])}
                onStatus={setCaptureStatus}
                onError={setCaptureError}
              />
              <VoiceInputButton
                disabled={isCreating}
                onTranscript={handleVoiceTranscript}
                onAudio={handleVoiceTaskIntent}
                onError={setVoiceError}
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
              type="submit"
              disabled={(!input.trim() && attachments.length === 0) || isCreating || (!defaults && isLoading)}
              className="p-2.5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
              aria-label="Create and start task"
              title="Create and start task"
              data-testid="create-start-task-button"
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
          {voiceError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">
                {voiceError}
              </p>
            </div>
          )}
          {captureError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">
                {captureError}
              </p>
            </div>
          )}
          {captureStatus && (
            <div className="px-4 pb-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {captureStatus}
              </p>
            </div>
          )}
          {voiceIntentMessage && (
            <div className="px-4 pb-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {voiceIntentMessage}
              </p>
            </div>
          )}
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mt-3">
          {planModeEnabled
            ? 'Plan mode creates the task in In Progress and starts the planning run immediately.'
            : 'Direct mode creates the task and starts execution immediately.'}
        </p>
      </form>
    </div>
  );
}

async function loadActivityScreenshot(
  path?: string,
  name?: string,
  base64?: string,
  mimeType?: string,
): Promise<File | null> {
  if (base64) {
    const file = fileFromBase64(base64, name || path?.split(/[\\/]/).pop() || 'activity-screenshot.png', mimeType);
    if (file) return file;
  }

  if (!path) return null;

  try {
    const response = await fetch(`/api/files/view?path=${encodeURIComponent(path)}`);
    if (!response.ok) return null;

    const blob = await response.blob();
    const fileName = name || path.split(/[\\/]/).pop() || 'activity-screenshot.png';
    return new File([blob], fileName, {
      type: blob.type || 'image/png',
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

function fileFromBase64(base64: string, name: string, mimeType = 'image/png'): File | null {
  try {
    const normalized = base64.replace(/^data:[^;,]+;base64,/, '');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], ensureImageExtension(name, mimeType), {
      type: mimeType,
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

function ensureImageExtension(name: string, mimeType: string): string {
  if (/\.[a-z0-9]+$/i.test(name)) return name;
  return `${name}.${extensionForMimeType(mimeType)}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'png';
  }
}
