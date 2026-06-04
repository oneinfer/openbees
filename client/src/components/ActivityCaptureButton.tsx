import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Crosshair, Loader2 } from 'lucide-react';
import { armActivitySelection, captureActivityScreenshot } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { createComposerAttachments, type ComposerAttachment } from './AttachmentPicker';

interface ActivityCaptureButtonProps {
  disabled?: boolean;
  inputText?: string;
  onCapture: (attachments: ComposerAttachment[]) => void;
  onStatus?: (message: string | null) => void;
  onError?: (message: string | null) => void;
}

const CAPTURE_WAIT_BUFFER_MS = 2500;

export function ActivityCaptureButton({
  disabled = false,
  inputText = '',
  onCapture,
  onStatus,
  onError,
}: ActivityCaptureButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const [busyAction, setBusyAction] = useState<'screenshot' | 'selection' | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanupSelectionWait = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (waitTimerRef.current) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
  }, []);

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const padding = 8;
    const gap = 8;
    const rect = button.getBoundingClientRect();
    const width = Math.min(224, window.innerWidth - padding * 2);
    const left = Math.min(
      Math.max(rect.left, padding),
      window.innerWidth - width - padding,
    );
    const menuHeight = menuRef.current?.offsetHeight ?? 94;
    const top = Math.max(padding, rect.top - menuHeight - gap);

    setMenuStyle({ position: 'fixed', zIndex: 50, left, top, width });
  }, []);

  useLayoutEffect(() => {
    if (menuOpen) updateMenuPosition();
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => cleanupSelectionWait, [cleanupSelectionWait]);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown, { passive: true });
    window.addEventListener('resize', updateMenuPosition, { passive: true });
    window.addEventListener('scroll', updateMenuPosition, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [menuOpen, updateMenuPosition]);

  const addCaptureEvent = useCallback(async (event: Record<string, unknown>, fallbackName: string) => {
    const file = await fileFromCaptureEvent(event, fallbackName);
    if (!file) throw new Error('The activity daemon did not return a screenshot image.');
    onCapture(createComposerAttachments([file]));
    onError?.(null);
  }, [onCapture, onError]);

  const handleScreenshot = useCallback(async () => {
    if (disabled || busyAction) return;
    setBusyAction('screenshot');
    setMenuOpen(false);
    onStatus?.('Taking screenshot...');
    onError?.(null);
    try {
      const event = await captureActivityScreenshot(inputText);
      await addCaptureEvent(event, 'screenshot.png');
      onStatus?.('Screenshot attached.');
    } catch (error) {
      onError?.(toErrorMessage(error, 'Failed to capture screenshot'));
      onStatus?.(null);
    } finally {
      setBusyAction(null);
    }
  }, [addCaptureEvent, busyAction, disabled, inputText, onError, onStatus]);

  const handleSelection = useCallback(async () => {
    if (disabled || busyAction) return;
    setBusyAction('selection');
    setMenuOpen(false);
    cleanupSelectionWait();
    onStatus?.('Drag-select a region. If you do nothing, a screenshot will be attached.');
    onError?.(null);

    try {
      const armed = await armActivitySelection(inputText);
      if (!armed.armed) throw new Error(armed.suppressed ? 'Activity capture is currently suppressed.' : 'Activity capture did not arm.');

      const armedAt = Date.now();
      const source = new EventSource('/api/activity/stream');
      eventSourceRef.current = source;

      const timeoutMs = Math.max(1, Number(armed.timeout_seconds ?? 10)) * 1000 + CAPTURE_WAIT_BUFFER_MS;
      waitTimerRef.current = setTimeout(() => {
        cleanupSelectionWait();
        setBusyAction(null);
        onStatus?.(null);
        onError?.('No drag selection or screenshot arrived from the activity daemon.');
      }, timeoutMs);

      const handleCapture = async (message: MessageEvent<string>) => {
        try {
          const event = JSON.parse(message.data) as Record<string, unknown>;
          const trigger = typeof event.trigger === 'string' ? event.trigger : '';
          if (trigger !== 'manual_selection' && trigger !== 'manual_screenshot' && trigger !== 'voice_selection' && trigger !== 'voice_screenshot') return;
          const timestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Date.now();
          if (Number.isFinite(timestamp) && timestamp < armedAt - 1000) return;
          cleanupSelectionWait();
          await addCaptureEvent(event, trigger.includes('selection') ? 'selected-region.png' : 'screenshot.png');
          onStatus?.(trigger.includes('selection') ? 'Selected region attached.' : 'Screenshot attached.');
        } catch (error) {
          onError?.(toErrorMessage(error, 'Failed to attach captured screen context'));
          onStatus?.(null);
        } finally {
          setBusyAction(null);
        }
      };

      source.addEventListener('snapshot', handleCapture as EventListener);
      source.onmessage = handleCapture;
      source.onerror = () => {
        cleanupSelectionWait();
        setBusyAction(null);
        onStatus?.(null);
        onError?.('Activity capture stream disconnected.');
      };
    } catch (error) {
      cleanupSelectionWait();
      setBusyAction(null);
      onError?.(toErrorMessage(error, 'Failed to arm drag selection'));
      onStatus?.(null);
    }
  }, [addCaptureEvent, busyAction, cleanupSelectionWait, disabled, inputText, onError, onStatus]);

  const title = busyAction === 'screenshot'
    ? 'Taking screenshot'
    : busyAction === 'selection'
      ? 'Waiting for drag selection'
      : 'Capture screen context';

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled || Boolean(busyAction)}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((current) => !current)}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200"
      >
        {busyAction ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
      </button>

      {menuOpen && createPortal(
        <div
          ref={menuRef}
          style={menuStyle ?? { position: 'fixed', left: -9999, top: -9999, zIndex: 50 }}
          role="menu"
          className="overflow-hidden rounded-lg border border-zinc-200 bg-white py-1.5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
            onClick={handleScreenshot}
          >
            <Camera size={15} className="shrink-0 text-zinc-400 dark:text-zinc-500" />
            <span>Take screenshot</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
            onClick={handleSelection}
          >
            <Crosshair size={15} className="shrink-0 text-zinc-400 dark:text-zinc-500" />
            <span>Drag-select region</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

async function fileFromCaptureEvent(event: Record<string, unknown>, fallbackName: string): Promise<File | null> {
  const image = imageFromCaptureEvent(event);
  if (!image) return null;
  const name = image.name || fallbackName;

  if (image.base64) {
    return fileFromBase64(image.base64, name, image.mimeType);
  }

  if (!image.path) return null;
  const response = await fetch(`/api/files/view?path=${encodeURIComponent(image.path)}`);
  if (!response.ok) return null;
  const blob = await response.blob();
  return new File([blob], name, {
    type: blob.type || image.mimeType,
    lastModified: Date.now(),
  });
}

function imageFromCaptureEvent(event: Record<string, unknown>): { path?: string; base64?: string; mimeType: string; name?: string } | null {
  const images = recordValue(event.images);
  if (!images) return null;

  for (const key of ['selection_crop', 'screenshot', 'cursor_crop']) {
    const image = recordValue(images[key]);
    if (!image) continue;
    const path = typeof image.path === 'string' ? image.path : undefined;
    const base64 = typeof image.base64 === 'string' ? image.base64 : undefined;
    const mimeType = typeof image.mimeType === 'string'
      ? image.mimeType
      : typeof image.mime_type === 'string'
        ? image.mime_type
        : 'image/png';
    const name = path?.split(/[\\/]/).pop();
    if (path || base64) return { path, base64, mimeType, name };
  }

  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
