import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { ArrowUp, Loader2, ChevronDown, ChevronRight, Check, Terminal, FileText, FilePenLine, Globe, Code, Wrench, Image as ImageIcon, X } from 'lucide-react';
import { InputToolbar, ContextRing } from './InputToolbar';
import { VoiceInputButton } from './VoiceInputButton';
import {
  AttachmentPicker,
  AttachmentPreviewList,
  composerAttachmentsFromClipboard,
  type ComposerAttachment,
} from './AttachmentPicker';
import { ActivityCaptureButton } from './ActivityCaptureButton';
import { ArtifactViewer, ChatArtifacts, collectChatArtifacts, type ChatArtifact } from './ChatArtifacts';
import { MarkdownContent } from './MarkdownContent';
import { useChat, ToolProgressEvent } from '../hooks/useChat';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { handleChatKeyDown } from '../lib/keyboard';
import { fileViewUrl } from '../lib/api';
import type { AgentRunSettings } from '../lib/api';
import type { ChatAttachment, TaskStatus } from '@shared/types';

interface TaskChatProps {
  taskId: string;
  taskStatus: TaskStatus;
  initialMessage?: string;
  initialSettings?: AgentRunSettings;
  emptyMessage?: string;
  inputPlaceholder?: string;
  workspacePath?: string | null;
}

function ThinkingBlock({ content, isLive }: { content: string; isLive: boolean }) {
  const [expanded, setExpanded] = useState(isLive);

  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  if (!content) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{isLive ? 'Thinking…' : 'Thought process'}</span>
        {isLive && <Loader2 size={10} className="animate-spin" />}
      </button>
      {expanded && (
        <div className="mt-2 ml-1 pl-4 py-1 border-l-2 border-zinc-200 dark:border-zinc-700 text-xs text-zinc-400 dark:text-zinc-500 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  terminal: Terminal,
  process: Terminal,
  read_file: FileText,
  write_file: FilePenLine,
  patch: FilePenLine,
  execute_code: Code,
  web_search: Globe,
  web_extract: Globe,
  browser_navigate: Globe,
  browser_snapshot: Globe,
  browser_vision: Globe,
};

const CHAT_COLUMN_CLASS = 'w-full max-w-[760px] mx-auto';
const ATTACHMENT_CONTEXT_PATTERN = /\n*\s*The user attached the following file(?:s)?\.[\s\S]*?<attachments>[\s\S]*?<\/attachments>\s*$/;
const ATTACHMENTS_PATTERN = /<attachments>[\s\S]*?<\/attachments>/;
const ACTIVITY_CONTEXT_SECTION_PATTERN = /\n*(?:Captured selected text|Active window|Captured image context is available for inspection):[\s\S]*?(?=\n\n(?:Captured selected text|Active window|Captured image context is available for inspection):|$)/gi;

function getToolIcon(name: string) {
  return TOOL_ICONS[name] ?? Wrench;
}

function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function displayMessageContent(content: string): string {
  return stripActivityContextSections(content.replace(ATTACHMENT_CONTEXT_PATTERN, '')).trim();
}

function stripActivityContextSections(content: string): string {
  const withoutActivitySections = content.replace(ACTIVITY_CONTEXT_SECTION_PATTERN, '');
  const userRequestMatch = withoutActivitySections.match(/^\s*User request:\s*\n([\s\S]*?)\s*$/i);
  if (userRequestMatch) return userRequestMatch[1];
  return withoutActivitySections;
}

function parseMessageAttachments(content: string): ChatAttachment[] {
  const match = content.match(ATTACHMENTS_PATTERN);
  if (!match || typeof DOMParser === 'undefined') return [];

  const document = new DOMParser().parseFromString(match[0], 'application/xml');
  if (document.querySelector('parsererror')) return [];

  return Array.from(document.querySelectorAll('attachment')).map((element, index) => {
    const text = (tagName: string) => element.querySelector(tagName)?.textContent ?? '';
    const mimeType = text('mime_type') || 'application/octet-stream';
    const path = text('absolute_path');
    const name = text('name') || path.split(/[\\/]/).pop() || 'attachment';
    const size = Number(text('size_bytes'));
    const kind: ChatAttachment['kind'] = element.getAttribute('kind') === 'image' || mimeType.startsWith('image/')
      ? 'image'
      : 'file';

    return {
      id: `${path || name}-${index}`,
      name,
      path,
      mimeType,
      size: Number.isFinite(size) ? size : 0,
      kind,
    };
  }).filter((attachment) => attachment.path);
}

function displayMessageAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments;
}

function MessageAttachmentList({
  attachments,
  onOpenImage,
}: {
  attachments: ChatAttachment[];
  onOpenImage: (attachment: ChatAttachment) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-2 grid max-w-full gap-2">
      {attachments.map((attachment) => {
        const isImage = attachment.kind === 'image' || attachment.mimeType.startsWith('image/');
        const href = fileViewUrl(attachment.path);

        if (isImage) {
          return (
            <button
              key={attachment.id}
              type="button"
              onClick={() => onOpenImage(attachment)}
              className="group overflow-hidden rounded-lg border border-zinc-200 bg-white text-left shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600"
              title={`Open ${attachment.name}`}
            >
              <img
                src={href}
                alt={attachment.name}
                className="max-h-56 w-full max-w-sm bg-zinc-100 object-contain dark:bg-zinc-950"
                loading="lazy"
              />
              <span className="flex items-center gap-2 px-2.5 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                <ImageIcon size={14} className="shrink-0" />
                <span className="min-w-0 truncate">{attachment.name}</span>
              </span>
            </button>
          );
        }

        return (
          <a
            key={attachment.id}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-sm items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title={`Open ${attachment.name}`}
          >
            <FileText size={14} className="shrink-0 text-zinc-400" />
            <span className="min-w-0 truncate">{attachment.name}</span>
          </a>
        );
      })}
    </div>
  );
}

function ImageAttachmentViewer({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name}
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white transition-colors hover:bg-white/20"
        onClick={onClose}
        aria-label="Close image"
        title="Close"
      >
        <X size={18} />
      </button>
      <img
        src={fileViewUrl(attachment.path)}
        alt={attachment.name}
        className="max-h-[88vh] max-w-[92vw] rounded-lg bg-white object-contain shadow-2xl dark:bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      />
      <div className="absolute bottom-4 left-4 right-4 mx-auto max-w-xl truncate rounded-lg bg-zinc-950/70 px-3 py-2 text-center text-xs text-white">
        {attachment.name}
      </div>
    </div>
  );
}

function ToolCallBlock({ tool }: { tool: ToolProgressEvent }) {
  const Icon = getToolIcon(tool.tool);
  return (
    <div className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border ${
      tool.status === 'error'
        ? 'border-red-200 dark:border-red-900'
        : 'border-zinc-200 dark:border-zinc-700'
    }`}>
      <Icon size={14} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
      <span className={`text-sm font-medium shrink-0 ${
        tool.status === 'error'
          ? 'text-red-500 dark:text-red-400'
          : 'text-zinc-600 dark:text-zinc-300'
      }`}>
        {formatToolName(tool.tool)}
      </span>
      {tool.label && (
        <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono truncate min-w-0">
          {tool.label}
        </span>
      )}
      {tool.status === 'running' && <Loader2 size={14} className="animate-spin text-zinc-400 shrink-0" />}
      {tool.status === 'completed' && <Check size={14} className="text-zinc-400 shrink-0" />}
      {tool.duration != null && (
        <span className="text-xs text-zinc-300 dark:text-zinc-600 ml-auto shrink-0 tabular-nums">
          {tool.duration.toFixed(1)}s
        </span>
      )}
    </div>
  );
}

export function TaskChat({
  taskId,
  taskStatus,
  initialMessage,
  initialSettings,
  emptyMessage = 'Start a conversation with your assistant.',
  inputPlaceholder = 'Message your assistant...',
  workspacePath,
}: TaskChatProps) {
  const { messages, isStreaming, thinkingContent, activeTools, context, sendMessage, loadMessages } = useChat();
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(null);
  const [selectedAttachment, setSelectedAttachment] = useState<ChatAttachment | null>(null);
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const startupRef = useRef({ taskId, initialMessage, initialSettings });
  if (startupRef.current.taskId !== taskId) {
    startupRef.current = { taskId, initialMessage, initialSettings };
  }
  const { defaults, runtimeOptions, runtime, setRuntime, modelGroups, runtimeDefaultModel, model, setModel, reasoningEffort, setReasoningEffort, isLoading } = useAgentConfig(
    taskId,
    startupRef.current.initialSettings,
  );
  const waitingForTaskSettings = isLoading && !startupRef.current.initialSettings;
  const toolbarDefaults = waitingForTaskSettings ? null : defaults;
  const configPending = waitingForTaskSettings || (!defaults && isLoading);
  const isPendingTask = taskStatus === 'pending';
  const composerControlsDisabled = isPendingTask || configPending;
  const sendDisabled = composerControlsDisabled || isStreaming;
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const didInitialScrollRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadedTaskId(null);
    setSelectedArtifact(null);
    setSelectedAttachment(null);
    didInitialScrollRef.current = false;
    loadMessages(taskId)
      .then((loadedMessages) => {
        if (cancelled) return;
        setLoadedTaskId(taskId);
        const firstMessage = startupRef.current.initialMessage;
        if (firstMessage) {
          startupRef.current.initialMessage = undefined;
          if (loadedMessages.length === 0 && taskStatus !== 'pending') {
            sendMessage(taskId, firstMessage, startupRef.current.initialSettings);
          }
        }
      })
      .catch(() => {});
    inputRef.current?.focus();
    return () => { cancelled = true; };
  }, [taskId, taskStatus, loadMessages, sendMessage]);

  useLayoutEffect(() => {
    if (loadedTaskId !== taskId || didInitialScrollRef.current) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    didInitialScrollRef.current = true;
  }, [loadedTaskId, messages.length, taskId]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    const files = attachments.map((attachment) => attachment.file);
    if ((!text && files.length === 0) || sendDisabled) return;
    const messageText = text || (files.length === 1 ? 'Attached file.' : 'Attached files.');
    setInput('');
    setAttachments([]);
    for (const attachment of attachments) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    }
    await sendMessage(taskId, messageText, { runtime, model, reasoningEffort }, files);
  }, [attachments, input, sendDisabled, taskId, sendMessage, runtime, model, reasoningEffort]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => handleChatKeyDown(e, handleSubmit),
    [handleSubmit],
  );

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (composerControlsDisabled) return;

    const pastedAttachments = composerAttachmentsFromClipboard(event);
    if (pastedAttachments.length === 0) return;

    if (!event.clipboardData.getData('text/plain')) event.preventDefault();
    setAttachments((current) => [...current, ...pastedAttachments]);
  }, [composerControlsDisabled]);

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

  return (
    <div className="flex w-full flex-1 min-h-0">
      <div className={`flex min-w-0 flex-col transition-[width,flex-basis] duration-200 ${
        selectedArtifact ? 'basis-full xl:basis-[50%] 2xl:basis-[54%]' : 'basis-full'
      }`}>
      <div className="relative flex-1 min-h-0">
        <div
          ref={messagesContainerRef}
          className="h-full overflow-y-auto px-4 sm:px-6 py-4"
        >
          <div className={`${CHAT_COLUMN_CLASS} space-y-3`}>
            {messages.length === 0 && (
              <p className="text-sm text-zinc-400 dark:text-zinc-500 text-center py-12">
                {isPendingTask
                  ? 'Move this task to In Progress to activate the assistant.'
                  : emptyMessage}
              </p>
            )}
            {messages.map((msg, idx) => {
              if (msg.role === 'user') {
                const userContent = displayMessageContent(msg.content);
                const messageAttachments = displayMessageAttachments(parseMessageAttachments(msg.content));
                return (
                  <div key={msg.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2.5 text-sm leading-relaxed text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
                      {userContent && <div className="whitespace-pre-wrap">{userContent}</div>}
                      <MessageAttachmentList
                        attachments={messageAttachments}
                        onOpenImage={setSelectedAttachment}
                      />
                    </div>
                  </div>
                );
              }

              const isLastAssistant = idx === messages.length - 1 && msg.role === 'assistant';
              const thinkingToShow = isLastAssistant && isStreaming ? thinkingContent : (msg.thinking || '');
              const isLiveThinking = isLastAssistant && isStreaming && !!thinkingContent;
              const toolsToShow = isLastAssistant && isStreaming ? activeTools : (msg.tools ?? []);
              const artifacts = collectChatArtifacts(msg.content, toolsToShow);
              const showSpinner = isLastAssistant && isStreaming && !msg.content && !thinkingContent && !activeTools.some(t => t.status === 'running');

              return (
                <div key={msg.id} className="flex justify-start">
                  <div className="w-full px-1 sm:px-2">
                    {thinkingToShow && (
                      <ThinkingBlock content={thinkingToShow} isLive={isLiveThinking} />
                    )}
                    {toolsToShow.length > 0 && (
                      <div className="mb-4 space-y-2.5">
                        {toolsToShow.map((tool, i) => (
                          <ToolCallBlock key={`${tool.tool}-${i}`} tool={tool} />
                        ))}
                      </div>
                    )}
                    <ChatArtifacts artifacts={artifacts} onOpenArtifact={setSelectedArtifact} />
                    <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                      {msg.content ? (
                        <MarkdownContent content={msg.content} isStreaming={isLastAssistant && isStreaming} />
                      ) : (
                        showSpinner && (
                          <span className="inline-flex items-center gap-2 text-zinc-400 dark:text-zinc-500">
                            <span>Thinking</span>
                            <span className="inline-flex gap-1">
                              {[0, 150, 300].map((delay) => (
                                <span
                                  key={delay}
                                  className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"
                                  style={{ animationDelay: `${delay}ms` }}
                                />
                              ))}
                            </span>
                          </span>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 py-4 border-t border-zinc-100 dark:border-zinc-800">
        <div className={`${CHAT_COLUMN_CLASS} rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800`}>
          <AttachmentPreviewList
            attachments={attachments}
            disabled={composerControlsDisabled}
            onChange={setAttachments}
          />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isPendingTask ? 'Move this task to In Progress to activate it...' : inputPlaceholder}
            rows={2}
            disabled={isPendingTask}
            className="w-full resize-none bg-transparent px-5 pt-3 pb-1 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none leading-relaxed"
          />
          <div className="flex items-center justify-between px-4 pb-3">
            <div className="flex min-w-0 items-center gap-2 flex-wrap">
              <AttachmentPicker
                attachments={attachments}
                disabled={composerControlsDisabled}
                onChange={setAttachments}
              />
              <ActivityCaptureButton
                disabled={composerControlsDisabled}
                inputText={input}
                onCapture={(nextAttachments) => setAttachments((current) => [...current, ...nextAttachments])}
                onStatus={setCaptureStatus}
                onError={setCaptureError}
              />
              <VoiceInputButton
                disabled={composerControlsDisabled}
                onTranscript={handleVoiceTranscript}
                onError={setVoiceError}
              />
              <InputToolbar
                runtime={runtime}
                model={model}
                reasoningEffort={reasoningEffort}
                defaults={toolbarDefaults}
                runtimeDefaultModel={runtimeDefaultModel}
                runtimeOptions={runtimeOptions}
                modelGroups={modelGroups}
                disabled={composerControlsDisabled}
                onRuntimeChange={setRuntime}
                onModelChange={setModel}
                onReasoningEffortChange={setReasoningEffort}
              />
            </div>
            <div className="flex items-center gap-2">
              {context && <ContextRing context={context} />}
              <button
                onClick={handleSubmit}
                disabled={(!input.trim() && attachments.length === 0) || sendDisabled}
                className="p-2 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
              >
                <ArrowUp size={14} />
              </button>
            </div>
          </div>
          {voiceError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">{voiceError}</p>
            </div>
          )}
          {captureError && (
            <div className="px-4 pb-3">
              <p className="text-xs text-red-500 dark:text-red-400">{captureError}</p>
            </div>
          )}
          {captureStatus && (
            <div className="px-4 pb-3">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{captureStatus}</p>
            </div>
          )}
        </div>
      </div>
      </div>
      {selectedArtifact && (
        <aside className="hidden min-h-0 min-w-[420px] flex-1 xl:block">
          <ArtifactViewer
            artifact={selectedArtifact}
            workspacePath={workspacePath}
            onClose={() => setSelectedArtifact(null)}
          />
        </aside>
      )}
      {selectedAttachment && (
        <ImageAttachmentViewer
          attachment={selectedAttachment}
          onClose={() => setSelectedAttachment(null)}
        />
      )}
    </div>
  );
}
