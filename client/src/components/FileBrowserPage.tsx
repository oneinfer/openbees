import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AlertCircle,
  ChevronUp,
  Download,
  File,
  FileText,
  Folder,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import type { FileCreateType, FileEntry, FileListResponse, FileReadResponse } from '@shared/types';
import {
  ApiError,
  createFileEntry,
  deleteFileEntry,
  fileDownloadUrl,
  listFiles,
  readFile,
  renameFileEntry,
  uploadFileEntries,
  writeFile,
} from '../lib/api';
import { formatBytes, formatDate, toErrorMessage } from '../lib/format';
import { DeleteConfirmModal } from './DeleteConfirmModal';

const DEFAULT_FILE_BROWSER_PATH = '~/.minions/workspace';

type NameDialog =
  | { mode: 'create'; type: FileCreateType }
  | { mode: 'rename'; entry: FileEntry };

type DeleteDialog = {
  entry: FileEntry;
  busy: boolean;
  error: string | null;
};

export function FileBrowserPage() {
  const fileUploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState<FileListResponse | null>(null);
  const [pathInput, setPathInput] = useState(DEFAULT_FILE_BROWSER_PATH);
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [openFile, setOpenFile] = useState<FileReadResponse | null>(null);
  const [content, setContent] = useState('');
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);

  const isDirty = openFile ? content !== openFile.content : false;
  const selectedPath = selectedEntry?.path ?? openFile?.path ?? null;
  const downloadTargetPath = selectedPath ?? directory?.path ?? null;

  const loadDirectory = useCallback(async (targetPath: string, reportError = true) => {
    setLoadingDirectory(true);
    try {
      const nextDirectory = await listFiles(targetPath);
      setDirectory(nextDirectory);
      setPathInput(nextDirectory.displayPath);
      setError(null);
      return nextDirectory;
    } catch (err) {
      if (reportError) setError(toErrorMessage(err, 'Failed to load directory'));
      throw err;
    } finally {
      setLoadingDirectory(false);
    }
  }, []);

  const clearOpenFile = useCallback(() => {
    setOpenFile(null);
    setSelectedEntry(null);
    setContent('');
    setFileError(null);
    setConflict(false);
  }, []);

  const applyOpenFile = useCallback((file: FileReadResponse, entry?: FileEntry) => {
    setOpenFile(file);
    setContent(file.content);
    setSelectedEntry(entry ?? entryFromReadResponse(file));
    setFileError(null);
    setConflict(false);
    setError(null);
  }, []);

  const openTextFile = useCallback(async (targetPath: string, entry?: FileEntry) => {
    setLoadingFile(true);
    try {
      const file = await readFile(targetPath);
      applyOpenFile(file, entry);
      return file;
    } catch (err) {
      setOpenFile(null);
      setContent('');
      setSelectedEntry(entry ?? null);
      setFileError(toErrorMessage(err, 'Failed to open file'));
      throw err;
    } finally {
      setLoadingFile(false);
    }
  }, [applyOpenFile]);

  useEffect(() => {
    loadDirectory(DEFAULT_FILE_BROWSER_PATH).catch(() => undefined);
  }, [loadDirectory]);

  useEffect(() => {
    folderUploadInputRef.current?.setAttribute('webkitdirectory', '');
    folderUploadInputRef.current?.setAttribute('directory', '');
  }, []);

  async function navigateToDirectory(targetPath: string) {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    await loadDirectory(targetPath).then(() => clearOpenFile()).catch(() => undefined);
  }

  async function handlePathSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;

    const targetPath = pathInput.trim() || DEFAULT_FILE_BROWSER_PATH;
    try {
      await loadDirectory(targetPath, false);
      clearOpenFile();
      return;
    } catch {
      // The pasted path may be a file. Try opening it after directory navigation fails.
    }

    try {
      const file = await openTextFile(targetPath);
      const parentPath = parentPathFor(file.path);
      if (parentPath) {
        const nextDirectory = await loadDirectory(parentPath, false);
        const matchingEntry = nextDirectory.entries.find((entry) => entry.path === file.path);
        applyOpenFile(file, matchingEntry);
      }
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to open path'));
    }
  }

  async function handleEntryOpen(entry: FileEntry) {
    if (openFile?.path !== entry.path && isDirty && !window.confirm('Discard unsaved changes?')) return;

    if (entry.type === 'directory') {
      await navigateToDirectory(entry.path);
      return;
    }

    if (entry.type === 'symlink') {
      try {
        await loadDirectory(entry.path, false);
        clearOpenFile();
        return;
      } catch {
        // Fall through to text open for symlinks that target files.
      }
    }

    await openTextFile(entry.path, entry).catch(() => undefined);
  }

  async function handleRefresh() {
    if (!directory) return;
    await Promise.all([
      loadDirectory(directory.path).catch(() => undefined),
      openFile && !isDirty
        ? openTextFile(openFile.path, selectedEntry ?? undefined).catch(() => undefined)
        : undefined,
    ]);
  }

  function handleDownload() {
    if (!downloadTargetPath) return;
    if (
      openFile
      && isDirty
      && downloadTargetPath === openFile.path
      && !window.confirm('Download the saved file from disk? Unsaved edits are not included.')
    ) {
      return;
    }

    const link = document.createElement('a');
    link.href = fileDownloadUrl(downloadTargetPath);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function openUploadPicker(type: 'files' | 'folder') {
    setUploadMenuOpen(false);
    if (type === 'folder') folderUploadInputRef.current?.click();
    else fileUploadInputRef.current?.click();
  }

  async function handleUploadInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (!directory || files.length === 0) return;

    setUploading(true);
    setError(null);
    try {
      await uploadFileEntries(directory.path, files);
      await loadDirectory(directory.path, false);
      if (openFile && !isDirty) {
        await openTextFile(openFile.path, selectedEntry ?? undefined).catch(() => undefined);
      }
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to upload files'));
    } finally {
      setUploading(false);
    }
  }

  async function handleSave(overwrite = false) {
    if (!openFile || !isDirty) return;

    setSaving(true);
    try {
      const result = await writeFile(openFile.path, content, openFile.modifiedAt, overwrite);
      setOpenFile({
        ...openFile,
        content,
        size: result.size,
        modifiedAt: result.modifiedAt,
        displayPath: result.displayPath,
      });
      setConflict(false);
      setFileError(null);
      if (directory) await loadDirectory(directory.path, false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setFileError('File changed on disk. Save again to overwrite.');
      } else {
        setFileError(toErrorMessage(err, 'Failed to save file'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDiscard() {
    if (!openFile) return;
    await openTextFile(openFile.path, selectedEntry ?? undefined).catch(() => undefined);
  }

  function openCreateDialog(type: FileCreateType) {
    setNameDialog({ mode: 'create', type });
    setNameValue('');
    setNameError(null);
  }

  function openRenameDialog(entry: FileEntry) {
    setNameDialog({ mode: 'rename', entry });
    setNameValue(entry.name);
    setNameError(null);
  }

  async function handleNameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nameDialog || !directory) return;

    setNameBusy(true);
    setNameError(null);
    try {
      if (nameDialog.mode === 'create') {
        const { entry } = await createFileEntry(
          directory.path,
          nameValue,
          nameDialog.type,
          nameDialog.type === 'file' ? '' : undefined,
        );
        const nextDirectory = await loadDirectory(directory.path, false);
        setNameDialog(null);

        if (entry.type === 'file') {
          const matchingEntry = nextDirectory.entries.find((candidate) => candidate.path === entry.path) ?? entry;
          await openTextFile(entry.path, matchingEntry).catch(() => undefined);
        } else {
          setSelectedEntry(nextDirectory.entries.find((candidate) => candidate.path === entry.path) ?? entry);
        }
      } else {
        const previousPath = nameDialog.entry.path;
        const { entry } = await renameFileEntry(previousPath, nameValue);
        const nextDirectory = await loadDirectory(directory.path, false);
        const matchingEntry = nextDirectory.entries.find((candidate) => candidate.path === entry.path) ?? entry;
        setNameDialog(null);

        if (openFile?.path === previousPath && entry.type === 'file') {
          await openTextFile(entry.path, matchingEntry).catch(() => undefined);
        } else if (selectedEntry?.path === previousPath) {
          setSelectedEntry(matchingEntry);
        }
      }
    } catch (err) {
      setNameError(toErrorMessage(err, 'Action failed'));
    } finally {
      setNameBusy(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteDialog || !directory) return;

    const target = deleteDialog.entry;
    setDeleteDialog({ ...deleteDialog, busy: true, error: null });
    try {
      await deleteFileEntry(target.path, target.type === 'directory');
      await loadDirectory(directory.path, false);
      if (openFile && isSameOrChildPath(target.path, openFile.path)) clearOpenFile();
      if (selectedEntry && isSameOrChildPath(target.path, selectedEntry.path)) setSelectedEntry(null);
      setDeleteDialog(null);
    } catch (err) {
      setDeleteDialog({
        ...deleteDialog,
        busy: false,
        error: toErrorMessage(err, 'Failed to delete file entry'),
      });
    }
  }

  let editorStatus: string | null = null;
  if (openFile) {
    if (saving) editorStatus = 'Saving';
    else if (conflict) editorStatus = 'Changed on disk';
    else if (isDirty) editorStatus = 'Unsaved';
    else editorStatus = 'Saved';
  }

  return (
    <div className="flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-4 px-6 py-5">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Files</h1>
              <p className="truncate text-xs font-mono text-zinc-500 dark:text-zinc-400">
                {directory?.displayPath ?? DEFAULT_FILE_BROWSER_PATH}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setUploadMenuOpen((open) => !open)}
                  disabled={!directory || uploading}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {uploading ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
                  Upload
                </button>
                {uploadMenuOpen && (
                  <div className="absolute right-0 z-30 mt-2 w-36 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                    <button
                      type="button"
                      onClick={() => openUploadPicker('files')}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      <FileText size={14} />
                      Files
                    </button>
                    <button
                      type="button"
                      onClick={() => openUploadPicker('folder')}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      <Folder size={14} />
                      Folder
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={handleDownload}
                disabled={!downloadTargetPath}
                title={selectedEntry || openFile ? 'Download selected' : 'Download current folder'}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Download size={15} />
                Download
              </button>
              <button
                type="button"
                onClick={() => openCreateDialog('file')}
                disabled={!directory}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Plus size={15} />
                File
              </button>
              <button
                type="button"
                onClick={() => openCreateDialog('directory')}
                disabled={!directory}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Plus size={15} />
                Folder
              </button>
            </div>
          </div>

          <input
            ref={fileUploadInputRef}
            type="file"
            multiple
            onChange={handleUploadInputChange}
            className="hidden"
          />
          <input
            ref={folderUploadInputRef}
            type="file"
            multiple
            onChange={handleUploadInputChange}
            className="hidden"
          />

          <form onSubmit={handlePathSubmit} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => directory?.parentPath && navigateToDirectory(directory.parentPath)}
              disabled={!directory?.parentPath || loadingDirectory}
              title="Go up"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <ChevronUp size={17} />
            </button>
            <input
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 font-mono text-sm text-zinc-900 outline-none transition-colors focus:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
              placeholder={DEFAULT_FILE_BROWSER_PATH}
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={loadingDirectory}
              className="inline-flex h-9 shrink-0 items-center rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              Open
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={!directory || loadingDirectory}
              title="Refresh"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              {loadingDirectory ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            </button>
          </form>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            <AlertCircle size={15} className="shrink-0" />
            <span className="min-w-0 truncate">{error}</span>
          </div>
        )}

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
          <section className="min-h-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                Entries
              </span>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">
                {directory?.entries.length ?? 0}
              </span>
            </div>
            <div className="h-full min-h-0 divide-y divide-zinc-100 overflow-y-auto pb-10 dark:divide-zinc-800">
              {loadingDirectory && !directory && (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
                  <Loader2 size={14} className="animate-spin" />
                  Loading files
                </div>
              )}
              {!loadingDirectory && directory?.entries.length === 0 && (
                <div className="px-3 py-10 text-center text-sm text-zinc-400 dark:text-zinc-500">
                  Empty directory.
                </div>
              )}
              {directory?.entries.map((entry) => (
                <FileEntryRow
                  key={entry.path}
                  entry={entry}
                  selected={selectedPath === entry.path}
                  onOpen={() => handleEntryOpen(entry)}
                  onRename={() => openRenameDialog(entry)}
                  onDelete={() => setDeleteDialog({ entry, busy: false, error: null })}
                />
              ))}
            </div>
          </section>

          <section className="min-h-0 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {!openFile && !selectedEntry && !loadingFile && (
              <div className="flex h-full items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
                Select a text file.
              </div>
            )}

            {loadingFile && !openFile && (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                <Loader2 size={15} className="animate-spin" />
                Opening file
              </div>
            )}

            {!openFile && selectedEntry && fileError && (
              <div className="flex h-full min-h-0 flex-col">
                <EditorHeader
                  name={selectedEntry.name}
                  path={selectedEntry.displayPath}
                  size={selectedEntry.size}
                  modifiedAt={selectedEntry.modifiedAt}
                  status={null}
                  onRename={() => openRenameDialog(selectedEntry)}
                  onDelete={() => setDeleteDialog({ entry: selectedEntry, busy: false, error: null })}
                />
                <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                  <AlertCircle size={15} className="shrink-0" />
                  <span className="min-w-0 truncate">{fileError}</span>
                </div>
                <div className="min-h-0 flex-1 p-4 text-sm text-zinc-500 dark:text-zinc-400">
                  {selectedEntry.type === 'directory' ? 'Directory' : selectedEntry.type}
                </div>
              </div>
            )}

            {openFile && (
              <div className="flex h-full min-h-0 flex-col">
                <EditorHeader
                  name={openFile.name}
                  path={openFile.displayPath}
                  size={openFile.size}
                  modifiedAt={openFile.modifiedAt}
                  status={editorStatus}
                  onRename={() => selectedEntry && openRenameDialog(selectedEntry)}
                  onDelete={() => selectedEntry && setDeleteDialog({ entry: selectedEntry, busy: false, error: null })}
                />

                {fileError && (
                  <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                    <AlertCircle size={15} className="shrink-0" />
                    <span className="min-w-0 truncate">{fileError}</span>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
                  <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {formatBytes(openFile.size)} - {formatDate(openFile.modifiedAt)}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={handleDiscard}
                      disabled={!isDirty || saving}
                      title="Discard changes"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-900 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    >
                      <RotateCcw size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSave(conflict)}
                      disabled={!isDirty || saving}
                      className="inline-flex h-8 items-center gap-2 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                    >
                      {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                      {conflict ? 'Overwrite' : 'Save'}
                    </button>
                  </div>
                </div>

                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none border-0 bg-white p-4 font-mono text-sm leading-relaxed text-zinc-900 outline-none dark:bg-zinc-950 dark:text-zinc-100"
                />
              </div>
            )}
          </section>
        </div>
      </div>

      {nameDialog && (
        <NameDialogModal
          title={nameDialog.mode === 'create' ? `New ${nameDialog.type}` : 'Rename'}
          label={nameDialog.mode === 'create' ? 'Name' : 'New name'}
          value={nameValue}
          busy={nameBusy}
          error={nameError}
          confirmLabel={nameDialog.mode === 'create' ? 'Create' : 'Rename'}
          onChange={setNameValue}
          onSubmit={handleNameSubmit}
          onCancel={() => setNameDialog(null)}
        />
      )}

      {deleteDialog && (
        <DeleteConfirmModal
          zIndex={60}
          title={`Delete ${deleteDialog.entry.type}`}
          body={
            deleteDialog.entry.type === 'directory'
              ? `Delete ${deleteDialog.entry.displayPath} and everything inside it?`
              : `Delete ${deleteDialog.entry.displayPath}?`
          }
          confirmLabel="Delete"
          isConfirming={deleteDialog.busy}
          error={deleteDialog.error}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteDialog(null)}
        />
      )}
    </div>
  );
}

function FileEntryRow({
  entry,
  selected,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: FileEntry;
  selected: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 transition-colors ${
        selected
          ? 'bg-zinc-100 dark:bg-zinc-800'
          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
      }`}
      title={entry.displayPath}
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 px-3 py-2.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={entry.hidden ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-500 dark:text-zinc-400'}>
            <EntryIcon entry={entry} />
          </span>
          <div className="min-w-0 flex-1">
            <p className={`truncate text-sm font-medium ${
              entry.hidden
                ? 'text-zinc-500 dark:text-zinc-500'
                : 'text-zinc-900 dark:text-zinc-100'
            }`}>
              {entry.name}
            </p>
            <p className="mt-0.5 truncate text-xs text-zinc-400 dark:text-zinc-500">
              {entry.type === 'directory' ? 'Folder' : formatBytes(entry.size)}
              {entry.modifiedAt ? ` - ${formatDate(entry.modifiedAt)}` : ''}
            </p>
          </div>
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1 pr-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={onRename}
          title="Rename"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-300"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === 'directory') return <Folder size={16} />;
  if (entry.type === 'file') return <FileText size={16} />;
  return <File size={16} />;
}

function EditorHeader({
  name,
  path,
  size,
  modifiedAt,
  status,
  onRename,
  onDelete,
}: {
  name: string;
  path: string;
  size: number | null;
  modifiedAt: number | null;
  status: string | null;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {name}
          </h2>
          <p className="mt-0.5 truncate text-xs font-mono text-zinc-400 dark:text-zinc-500">
            {path}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {status && (
            <span className="mr-2 rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {status}
            </span>
          )}
          <button
            type="button"
            onClick={onRename}
            title="Rename"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Delete"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
        <div>
          <p className="text-zinc-400 dark:text-zinc-500">Size</p>
          <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{formatBytes(size)}</p>
        </div>
        <div>
          <p className="text-zinc-400 dark:text-zinc-500">Modified</p>
          <p className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">{formatDate(modifiedAt)}</p>
        </div>
      </div>
    </div>
  );
}

function NameDialogModal({
  title,
  label,
  value,
  busy,
  error,
  confirmLabel,
  onChange,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  value: string;
  busy: boolean;
  error: string | null;
  confirmLabel: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <form
        onSubmit={onSubmit}
        className="relative mx-4 w-full max-w-sm rounded-xl border border-zinc-200 bg-white px-6 py-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
      >
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
          {label}
        </label>
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoFocus
          disabled={busy}
          className="mt-1.5 h-9 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition-colors focus:border-zinc-400 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
        />
        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-zinc-200 px-3.5 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function entryFromReadResponse(file: FileReadResponse): FileEntry {
  return {
    name: file.name,
    path: file.path,
    displayPath: file.displayPath,
    type: 'file',
    hidden: file.name.startsWith('.'),
    size: file.size,
    modifiedAt: file.modifiedAt,
    readable: true,
    writable: true,
  };
}

function parentPathFor(path: string): string | null {
  if (path === '/') return null;
  const normalized = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
  const index = normalized.lastIndexOf('/');
  if (index < 0) return null;
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  if (parentPath === childPath) return true;
  const prefix = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
  return childPath.startsWith(prefix);
}
