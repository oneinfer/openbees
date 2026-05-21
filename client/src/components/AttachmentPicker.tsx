import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Image as ImageIcon, Paperclip, Search, X } from 'lucide-react';

export interface ComposerAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

export function createComposerAttachments(files: Iterable<File>): ComposerAttachment[] {
  return Array.from(files).map((file) => ({
    id: crypto.randomUUID(),
    file,
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
  }));
}

export function composerAttachmentsFromClipboard(event: React.ClipboardEvent<HTMLElement>): ComposerAttachment[] {
  const files = clipboardFiles(event.clipboardData);
  return createComposerAttachments(files);
}

interface AttachmentPickerProps {
  attachments: ComposerAttachment[];
  disabled?: boolean;
  onChange: (attachments: ComposerAttachment[]) => void;
}

export function AttachmentPicker({
  attachments,
  disabled = false,
  onChange,
}: AttachmentPickerProps) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const padding = 8;
    const gap = 8;
    const rect = button.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - padding * 2);
    const left = Math.min(
      Math.max(rect.left, padding),
      window.innerWidth - width - padding,
    );
    const menuHeight = menuRef.current?.offsetHeight ?? 172;
    const top = Math.max(padding, rect.top - menuHeight - gap);

    setMenuStyle({ position: 'fixed', zIndex: 50, left, top, width });
  }, []);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown, { passive: true });
    window.addEventListener('resize', updatePosition, { passive: true });
    window.addEventListener('scroll', updatePosition, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;

    const next = createComposerAttachments(files);

    onChange([...attachments, ...next]);
    setOpen(false);
  }, [attachments, onChange]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        title="Add images and files"
        aria-label="Add images and files"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200"
      >
        <Paperclip size={16} />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          style={menuStyle ?? { position: 'fixed', left: -9999, top: -9999, zIndex: 50 }}
          className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          role="menu"
        >
          <div className="flex h-10 items-center gap-2 border-b border-zinc-100 px-3 text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
            <Search size={15} className="shrink-0" />
            <input
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              onKeyDown={(event) => event.stopPropagation()}
            />
          </div>

          <div className="py-1.5">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              onClick={() => inputRef.current?.click()}
            >
              <Paperclip size={15} className="shrink-0 text-zinc-400 dark:text-zinc-500" />
              <span>Add images & files</span>
            </button>
          </div>

          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

export function AttachmentPreviewList({
  attachments,
  disabled = false,
  onChange,
}: AttachmentPickerProps) {
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const removeAttachment = useCallback((id: string) => {
    const target = attachments.find((attachment) => attachment.id === id);
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
    onChange(attachments.filter((attachment) => attachment.id !== id));
  }, [attachments, onChange]);

  useEffect(() => {
    return () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 pt-3">
      {attachments.map((attachment) => {
        const isImage = attachment.file.type.startsWith('image/');
        return (
          <div
            key={attachment.id}
            className="flex h-10 max-w-full items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200"
            title={attachment.file.name}
          >
            {attachment.previewUrl ? (
              <img
                src={attachment.previewUrl}
                alt=""
                className="h-6 w-6 shrink-0 rounded object-cover"
              />
            ) : isImage ? (
              <ImageIcon size={15} className="shrink-0 text-zinc-400" />
            ) : (
              <FileText size={15} className="shrink-0 text-zinc-400" />
            )}
            <span className="min-w-0 max-w-[14rem] truncate">{attachment.file.name}</span>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              aria-label={`Remove ${attachment.file.name}`}
              title="Remove"
              onClick={() => removeAttachment(attachment.id)}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function clipboardFiles(data: DataTransfer): File[] {
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  const files = itemFiles.length > 0 ? itemFiles : Array.from(data.files);
  return files.map((file, index) => normalizePastedFile(file, index));
}

function normalizePastedFile(file: File, index: number): File {
  if (file.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;

  const extension = extensionForMime(file.type);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = file.type.startsWith('image/') ? 'pasted-image' : 'pasted-file';
  return new File([file], `${baseName}-${timestamp}-${index + 1}.${extension}`, {
    type: file.type || 'application/octet-stream',
    lastModified: Date.now(),
  });
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'bin';
  }
}
