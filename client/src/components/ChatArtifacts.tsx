import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, ExternalLink, FileArchive, FileCode, FileImage, FileSpreadsheet, Loader2, MonitorUp, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FileReadResponse, LiveChatTimelineItem, ToolProgressEvent } from '@shared/types';
import { ApiError, fileDownloadUrl, openSystemPath, readFile } from '../lib/api';
import { toErrorMessage } from '../lib/format';

export interface ChatArtifact {
  path: string;
  operation: 'modified' | 'created' | 'read' | 'deleted' | 'referenced';
  source: 'tool' | 'message';
}

const ABSOLUTE_WINDOWS_PATH = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n`]+\\)*[^\\/:*?"<>|\s`]+/g;
const ABSOLUTE_UNIX_PATH = /\/(?:[\w .@+-]+\/)+[\w .@+-]+/g;
const RELATIVE_FILE_PATH = /(?:^|[\s([`'"])([A-Za-z0-9_.@+-]+(?:[\\/][A-Za-z0-9_.@+-]+)+\.[A-Za-z0-9][A-Za-z0-9_.-]{0,15})/g;
const BARE_FILE_PATH = /(?:^|[\s([`'"])([A-Za-z0-9_.@+-]+\.[A-Za-z0-9][A-Za-z0-9_.-]{0,15})(?=$|[\s)\]'",;:])/g;

const WRITE_TOOL_PATTERN = /(write|edit|patch|apply|create|save|rename|move|delete|set-content|new-item|out-file|tee|touch)/i;
const READ_TOOL_PATTERN = /(read|open|cat|view|grep|search)/i;
const CREATE_TEXT_PATTERN = /(created|added|new file|new-item|touch|mkdir|writefile|set-content|cat\s*>|>\s*[^\s]+)/i;
const DELETE_TEXT_PATTERN = /(deleted|removed|remove-item|\brm\b|del\s+)/i;
const MODIFY_TEXT_PATTERN = /(changed|modified|updated|edited|patched|wrote|implemented|apply_patch|set-content|out-file|writefile)/i;
const FILE_LIKE_EXTENSION_PATTERN = /\.[A-Za-z0-9][A-Za-z0-9_.-]{0,15}$/;
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xls', '.xlsm', '.csv', '.ods']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.tar', '.gz']);
const DEFAULT_WORKSPACE_PATH = '~/.bees/workspace';
const WINDOWS_POSIX_DRIVE_PATH = /^\/([A-Za-z])(?:\/|$)/;
const RUNTIME_ARTIFACT_PATH_PATTERN = /(?:[\\/]AppData[\\/]Local[\\/]Temp[\\/]bees-runtime-prompts[\\/]|[\\/]AppData[\\/]Roaming[\\/]npm[\\/][^\\/]+\.CMD$|[\\/]node_modules[\\/]\.bin[\\/])/i;
const RUNTIME_ARTIFACT_NAME_PATTERN = /^(prompt\.txt|task-context\.json|codex\.cmd|claude\.cmd)$/i;

function normalizeWindowsPosixPath(path: string): string {
  const match = path.match(WINDOWS_POSIX_DRIVE_PATH);
  if (!match) return path;

  const rest = path.slice(3).replace(/\//g, '\\');
  return `${match[1].toUpperCase()}:\\${rest}`;
}

function looksLikeFilePath(path: string): boolean {
  const lastSegment = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return FILE_LIKE_EXTENSION_PATTERN.test(lastSegment);
}

function normalizePath(raw: string): string | null {
  let cleaned = raw
    .trim()
    .replace(/^["'`(<[]+/, '')
    .replace(/[>"'`)\],.;:]+$/g, '');

  if (!cleaned || cleaned.includes('://') || cleaned.startsWith('#')) return null;
  if (/^[A-Za-z]:[\\/]/.test(cleaned)) return cleaned.replace(/\//g, '\\');
  if (cleaned.startsWith('/') && cleaned.length > 1) return cleaned;
  if (cleaned.includes('/') || cleaned.includes('\\')) {
    const lastSegment = cleaned.split(/[\\/]/).pop() ?? '';
    return FILE_LIKE_EXTENSION_PATTERN.test(lastSegment) ? cleaned : null;
  }
  return null;
}

function isRuntimeArtifactPath(path: string): boolean {
  const normalized = path.replace(/\//g, '\\');
  const name = fileName(path);
  return RUNTIME_ARTIFACT_PATH_PATTERN.test(normalized)
    || (RUNTIME_ARTIFACT_NAME_PATTERN.test(name) && /[\\/]AppData[\\/]/i.test(normalized));
}

function addPath(
  map: Map<string, ChatArtifact>,
  raw: string,
  operation: ChatArtifact['operation'],
  source: ChatArtifact['source'],
  options?: { requireFileLike?: boolean },
) {
  const path = normalizePath(raw);
  if (!path) return;
  if (isRuntimeArtifactPath(path)) return;
  if (options?.requireFileLike && !looksLikeFilePath(path)) return;

  const existing = map.get(path);
  if (!existing) {
    map.set(path, { path, operation, source });
    return;
  }

  if (existing.operation === 'referenced' || existing.operation === 'read') {
    existing.operation = operation;
  }
  if (existing.source === 'message') existing.source = source;
}

function extractPathsFromText(
  text: string | undefined,
  map: Map<string, ChatArtifact>,
  operation: ChatArtifact['operation'],
  source: ChatArtifact['source'],
) {
  if (!text) return;

  for (const match of text.matchAll(ABSOLUTE_WINDOWS_PATH)) {
    addPath(map, match[0], operation, source, { requireFileLike: true });
  }
  for (const match of text.matchAll(ABSOLUTE_UNIX_PATH)) {
    addPath(map, match[0], operation, source, { requireFileLike: true });
  }
  for (const match of text.matchAll(RELATIVE_FILE_PATH)) addPath(map, match[1], operation, source);
  for (const match of text.matchAll(BARE_FILE_PATH)) addPath(map, match[1], operation, source);
}

function extractPathsFromUnknown(
  value: unknown,
  map: Map<string, ChatArtifact>,
  operation: ChatArtifact['operation'],
  depth = 0,
) {
  if (depth > 5 || value == null) return;

  if (typeof value === 'string') {
    extractPathsFromText(value, map, operation, 'tool');
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) extractPathsFromUnknown(item, map, operation, depth + 1);
    return;
  }

  if (typeof value !== 'object') return;

  for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
    const keyLooksPathy = /(path|file|filename|target|source|destination)/i.test(key);
    if (keyLooksPathy && typeof next === 'string') addPath(map, next, operation, 'tool');
    extractPathsFromUnknown(next, map, operation, depth + 1);
  }
}

function searchableText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => searchableText(item, depth + 1)).join('\n');
  if (typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([key, next]) => `${key}: ${searchableText(next, depth + 1)}`)
    .join('\n');
}

function operationForTool(tool: ToolProgressEvent): ChatArtifact['operation'] {
  const text = `${tool.tool}\n${tool.label ?? ''}\n${searchableText(tool.details)}`.toLowerCase();
  if (DELETE_TEXT_PATTERN.test(text)) return 'deleted';
  if (CREATE_TEXT_PATTERN.test(text)) return 'created';
  if (WRITE_TOOL_PATTERN.test(text) || MODIFY_TEXT_PATTERN.test(text)) return 'modified';
  if (READ_TOOL_PATTERN.test(text)) return 'read';
  return 'referenced';
}

function operationForMessageLine(line: string): ChatArtifact['operation'] {
  if (/deleted|removed/i.test(line)) return 'deleted';
  if (/created|added|new/i.test(line)) return 'created';
  if (/changed|modified|updated|edited|patched|wrote|implemented/i.test(line)) return 'modified';
  if (/read|opened|inspected/i.test(line)) return 'read';
  return 'referenced';
}

function addToolArtifacts(tool: ToolProgressEvent, artifacts: Map<string, ChatArtifact>) {
  const operation = operationForTool(tool);
  extractPathsFromText(tool.label, artifacts, operation, 'tool');
  extractPathsFromUnknown(tool.details, artifacts, operation);
}

export function collectChatArtifacts(
  content: string,
  tools?: ToolProgressEvent[],
  timeline?: LiveChatTimelineItem[],
): ChatArtifact[] {
  const artifacts = new Map<string, ChatArtifact>();

  for (const tool of tools ?? []) {
    if (tool.status === 'running') continue;
    addToolArtifacts(tool, artifacts);
  }

  for (const item of timeline ?? []) {
    if (item.type === 'tool') {
      if (item.tool.status !== 'running') addToolArtifacts(item.tool, artifacts);
    } else if (item.type === 'text') {
      for (const line of item.content.split('\n')) {
        extractPathsFromText(line, artifacts, operationForMessageLine(line), 'message');
      }
    }
  }

  for (const line of content.split('\n')) {
    extractPathsFromText(line, artifacts, operationForMessageLine(line), 'message');
  }

  return pruneArtifactAliases(Array.from(artifacts.values())).sort((a, b) => {
    const rank = { modified: 0, created: 1, read: 2, referenced: 3, deleted: 4 };
    return rank[a.operation] - rank[b.operation] || a.path.localeCompare(b.path);
  });
}

function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function pruneArtifactAliases(artifacts: ChatArtifact[]): ChatArtifact[] {
  return artifacts.filter((artifact) => {
    const normalized = comparablePath(artifact.path);
    const hasMoreSpecificAlias = artifacts.some((candidate) => {
      if (candidate.path === artifact.path) return false;
      const candidatePath = comparablePath(candidate.path);
      return candidatePath.endsWith(`/${normalized}`) && candidatePath.split('/').length > normalized.split('/').length;
    });
    return !hasMoreSpecificAlias;
  });
}

function isAbsoluteOrHomePath(path: string): boolean {
  return path.startsWith('~') || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function isWindowsHost(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /win/i.test(navigator.userAgent) || /win/i.test(navigator.platform);
}

function resolveArtifactPath(path: string, workspacePath?: string | null): string {
  if (isAbsoluteOrHomePath(path)) return path;
  const rootPath = workspacePath?.trim() || DEFAULT_WORKSPACE_PATH;
  if (!rootPath) return path;
  const separator = rootPath.includes('\\') ? '\\' : '/';
  return `${rootPath.replace(/[\\/]+$/, '')}${separator}${path}`;
}

function artifactPathCandidates(path: string, workspacePath?: string | null): string[] {
  const windowsPosixCandidate = normalizeWindowsPosixPath(path);
  const candidates = [resolveArtifactPath(path, workspacePath), path];
  const rootPath = workspacePath?.trim() || DEFAULT_WORKSPACE_PATH;

  if (path.startsWith('/') && !path.startsWith('//') && !WINDOWS_POSIX_DRIVE_PATH.test(path) && rootPath) {
    const separator = rootPath.includes('\\') ? '\\' : '/';
    const relativePath = path.replace(/^\/+/, '').replace(/\//g, separator);
    candidates.push(`${rootPath.replace(/[\\/]+$/, '')}${separator}${relativePath}`);
  }

  if (windowsPosixCandidate !== path) {
    candidates.push(windowsPosixCandidate);
  }

  if (!workspacePath?.trim() && !isAbsoluteOrHomePath(path)) {
    candidates.push(resolveArtifactPath(path, DEFAULT_WORKSPACE_PATH));
  }

  if (isWindowsHost() && path.startsWith('/') && !WINDOWS_POSIX_DRIVE_PATH.test(path)) {
    candidates.push(path.replace(/^\/+/, '').replace(/\//g, '\\'));
  }

  return [...new Set(candidates)];
}

function isBinaryFileError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 415 || err.code === 'BINARY_FILE');
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.code === 'ENOENT');
}

function resolveDownloadPath(artifactPath: string, displayPath: string, workspacePath?: string | null): string {
  if (displayPath && isAbsoluteOrHomePath(displayPath)) return displayPath;
  return resolveArtifactPath(artifactPath, workspacePath);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function extensionFor(path: string): string {
  const name = fileName(path);
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function artifactKind(path: string): 'spreadsheet' | 'image' | 'archive' | 'binary' | 'text' {
  const extension = extensionFor(path);
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'text';
}

function ArtifactIcon({ path, className = 'text-zinc-400' }: { path: string; className?: string }) {
  const kind = artifactKind(path);
  if (kind === 'spreadsheet') return <FileSpreadsheet size={16} className={className} />;
  if (kind === 'image') return <FileImage size={16} className={className} />;
  if (kind === 'archive') return <FileArchive size={16} className={className} />;
  return <FileCode size={16} className={className} />;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function operationLabel(operation: ChatArtifact['operation']): string {
  if (operation === 'created') return 'Created';
  if (operation === 'modified') return 'Changed';
  if (operation === 'deleted') return 'Deleted';
  if (operation === 'read') return 'Read';
  return 'File';
}

function diffLinesForContent(content: string, operation: ChatArtifact['operation']): { prefix: string; className: string; text: string }[] {
  const lines = content.split('\n');
  if (operation === 'created') {
    return lines.map((text) => ({
      prefix: '+',
      className: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
      text,
    }));
  }

  return lines.map((text) => ({
    prefix: ' ',
    className: 'text-zinc-700 dark:text-zinc-200',
    text,
  }));
}

function ChangesPreview({ content, operation }: { content: string; operation: ChatArtifact['operation'] }) {
  const lines = diffLinesForContent(content, operation);
  return (
    <div className="min-h-full p-4">
      {operation !== 'created' && (
        <div className="mb-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          Showing the current file snapshot. A before-run snapshot is not available for this artifact yet.
        </div>
      )}
      <pre className="overflow-auto rounded-lg border border-zinc-200 bg-white font-mono text-[12px] leading-relaxed dark:border-zinc-800 dark:bg-zinc-900">
        {lines.map((line, index) => (
          <div key={index} className={`flex min-w-max ${line.className}`}>
            <span className="w-8 shrink-0 select-none border-r border-zinc-200 px-2 text-right text-zinc-400 dark:border-zinc-800 dark:text-zinc-600">
              {line.prefix}
            </span>
            <span className="whitespace-pre-wrap break-words px-3">{line.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

export function ChatArtifacts({
  artifacts,
  onOpenArtifact,
}: {
  artifacts: ChatArtifact[];
  onOpenArtifact: (artifact: ChatArtifact) => void;
}) {
  if (artifacts.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        <FileCode size={13} />
        Artifacts
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {artifacts.map((artifact) => {
          const disabled = artifact.operation === 'deleted';
          return (
            <button
              key={artifact.path}
              type="button"
              onClick={() => !disabled && onOpenArtifact(artifact)}
              disabled={disabled}
              className="min-w-0 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-left transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
            >
              <div className="flex min-w-0 items-start gap-2">
                <ArtifactIcon path={artifact.path} className="mt-0.5 shrink-0 text-zinc-400" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {fileName(artifact.path)}
                    </span>
                    <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {operationLabel(artifact.operation)}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                    {artifact.path}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ArtifactViewer({
  artifact,
  workspacePath,
  onClose,
}: {
  artifact: ChatArtifact;
  workspacePath?: string | null;
  onClose: () => void;
}) {
  const pathCandidates = useMemo(
    () => artifactPathCandidates(artifact.path, workspacePath),
    [artifact.path, workspacePath],
  );
  const resolvedPath = pathCandidates[0];
  const [content, setContent] = useState<string | null>(null);
  const [displayPath, setDisplayPath] = useState(resolvedPath);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'changes'>('preview');
  const [openingLocal, setOpeningLocal] = useState(false);
  const [openLocalError, setOpenLocalError] = useState<string | null>(null);
  const actionPath = resolveDownloadPath(artifact.path, displayPath, workspacePath);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setError(null);
    setBinary(false);
    setOpenLocalError(null);
    setViewMode('preview');
    setDisplayPath(resolvedPath);

    async function loadArtifact() {
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        for (const path of pathCandidates) {
          try {
            const file = await readFile(path);
            if (cancelled) return;
            setContent(file.content);
            setDisplayPath(file.path || file.displayPath || path);
            setError(null);
            return;
          } catch (err) {
            if (cancelled) return;
            lastError = err;
            if (isBinaryFileError(err)) {
              setBinary(true);
              setDisplayPath(path);
              setError(null);
              return;
            }
            if (isNotFoundError(err)) continue;
            break;
          }
        }

        if (!isNotFoundError(lastError) || attempt === 5) break;
        await delay(250);
        if (cancelled) return;
      }

      if (!cancelled) {
        setError(toErrorMessage(lastError, 'Failed to open artifact'));
      }
    }

    loadArtifact()
      .catch((err) => {
        if (cancelled) return;
        setError(toErrorMessage(err, 'Failed to open artifact'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathCandidates, resolvedPath]);

  const handleCopy = async () => {
    if (content == null) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const handleOpenLocal = async () => {
    setOpeningLocal(true);
    setOpenLocalError(null);
    try {
      await openSystemPath(actionPath);
    } catch (err) {
      setOpenLocalError(toErrorMessage(err, 'Failed to open file locally'));
    } finally {
      setOpeningLocal(false);
    }
  };

  return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex min-w-0 items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ArtifactIcon path={resolvedPath} className="shrink-0 text-zinc-400" />
              <h2 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {fileName(displayPath || resolvedPath)}
              </h2>
              <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                {operationLabel(artifact.operation)}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-zinc-400 dark:text-zinc-500">
              {displayPath}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleCopy}
              disabled={content == null}
              title="Copy file"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <a
              href={fileDownloadUrl(actionPath)}
              title="Download file"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <Download size={15} />
            </a>
            <Link
              to={`/files?path=${encodeURIComponent(actionPath)}`}
              title="Open in Files"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <ExternalLink size={15} />
            </Link>
            <button
              type="button"
              onClick={handleOpenLocal}
              disabled={openingLocal}
              title="Open locally"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {openingLocal ? <Loader2 size={15} className="animate-spin" /> : <MonitorUp size={15} />}
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {content != null && (
          <div className="flex items-center gap-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            {(['preview', 'changes'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === mode
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                }`}
              >
                {mode === 'preview' ? 'Preview' : 'Changes'}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto bg-zinc-50 dark:bg-zinc-950">
          {loading && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <Loader2 size={15} className="animate-spin" />
              Opening artifact
            </div>
          )}
          {!loading && error && (
            <div className="p-4 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
          {!loading && binary && (
            <div className="flex h-full items-center justify-center p-6">
              <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                  <ArtifactIcon path={resolvedPath} className="text-zinc-500 dark:text-zinc-300" />
                </div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {artifactKind(resolvedPath) === 'spreadsheet' ? 'Spreadsheet artifact' : 'Binary artifact'}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                  This file cannot be shown as text here. You can download it, open it with the local app, or inspect it in Files.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-2">
                  <a
                    href={fileDownloadUrl(actionPath)}
                    className="inline-flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    <Download size={14} />
                    Download
                  </a>
                  <button
                    type="button"
                    onClick={handleOpenLocal}
                    disabled={openingLocal}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    {openingLocal ? <Loader2 size={14} className="animate-spin" /> : <MonitorUp size={14} />}
                    Open locally
                  </button>
                  <Link
                    to={`/files?path=${encodeURIComponent(actionPath)}`}
                    className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <ExternalLink size={14} />
                    Files
                  </Link>
                </div>
                {openLocalError && (
                  <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                    {openLocalError}
                  </p>
                )}
              </div>
            </div>
          )}
          {!loading && content != null && viewMode === 'preview' && (
            <pre className="min-h-full whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-relaxed text-zinc-800 dark:text-zinc-100">
              {content}
            </pre>
          )}
          {!loading && content != null && viewMode === 'changes' && (
            <ChangesPreview content={content} operation={artifact.operation} />
          )}
        </div>
      </div>
  );
}
