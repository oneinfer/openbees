import { useCallback, useEffect, useState } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { fetchAsrStatus } from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import type { AsrStatusResponse } from '@shared/types';

interface VoiceInputButtonProps {
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onAudio?: (audio: Blob) => Promise<void>;
  onError?: (message: string | null) => void;
}

export function VoiceInputButton({
  disabled = false,
  onTranscript,
  onAudio,
  onError,
}: VoiceInputButtonProps) {
  const [status, setStatus] = useState<AsrStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const recorder = useVoiceRecorder(onTranscript, onAudio);

  useEffect(() => {
    let cancelled = false;
    fetchAsrStatus()
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((error) => {
        if (!cancelled) setStatusError(toErrorMessage(error, 'Voice input is unavailable'));
      });
    return () => {
      cancelled = true;
      recorder.cancel();
    };
  }, []);

  useEffect(() => {
    onError?.(recorder.error ?? status?.error ?? statusError);
  }, [onError, recorder.error, status?.error, statusError]);

  const handleClick = useCallback(() => {
    if (recorder.isRecording) {
      recorder.stop();
      return;
    }
    recorder.start();
  }, [recorder]);

  const available = !!status?.enabled && !!status.available && recorder.isSupported;
  const buttonDisabled = disabled || recorder.isTranscribing || !available;
  const title = !recorder.isSupported
    ? 'Voice recording is not supported'
    : status?.enabled === false
      ? 'Voice input is disabled'
      : status?.available === false
        ? status.error || 'Voice input is unavailable'
        : recorder.isRecording
          ? 'Stop recording'
          : 'Record voice input';

  return (
    <button
      type="button"
      disabled={buttonDisabled}
      title={title}
      aria-label={title}
      aria-pressed={recorder.isRecording}
      onClick={handleClick}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        recorder.isRecording
          ? 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-900/50'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200'
      }`}
    >
      {recorder.isTranscribing ? (
        <Loader2 size={16} className="animate-spin" />
      ) : recorder.isRecording ? (
        <Square size={15} />
      ) : (
        <Mic size={16} />
      )}
    </button>
  );
}
