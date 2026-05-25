import { useCallback, useRef, useState } from 'react';
import { transcribeAudio } from '../lib/api';
import { toErrorMessage } from '../lib/format';

const MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function recorderOptions(): MediaRecorderOptions | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  return mimeType ? { mimeType } : undefined;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export function voiceRecordingSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';
}

export function useVoiceRecorder(onTranscript: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const shouldTranscribeRef = useRef(false);

  const cleanup = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
  }, []);

  const start = useCallback(async () => {
    if (!voiceRecordingSupported()) {
      setError('Voice recording is not supported in this browser.');
      return;
    }

    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const options = recorderOptions();
      const recorder = options ? new MediaRecorder(stream, options) : new MediaRecorder(stream);

      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      shouldTranscribeRef.current = true;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onerror = () => {
        setError('Recording failed.');
        shouldTranscribeRef.current = false;
        cleanup();
      };

      recorder.onstop = () => {
        const chunks = chunksRef.current;
        const mimeType = recorder.mimeType || options?.mimeType || 'audio/webm';
        const shouldTranscribe = shouldTranscribeRef.current;
        cleanup();

        if (!shouldTranscribe || chunks.length === 0) return;

        const audio = new Blob(chunks, { type: mimeType });
        setIsTranscribing(true);
        transcribeAudio(audio)
          .then((result) => {
            const text = result.text.trim();
            if (text) onTranscript(text);
            else setError('No speech was detected.');
          })
          .catch((err) => {
            setError(toErrorMessage(err, 'Failed to transcribe audio'));
          })
          .finally(() => setIsTranscribing(false));
      };

      recorder.start();
      setIsRecording(true);
    } catch (err) {
      cleanup();
      setError(toErrorMessage(err, 'Microphone access failed'));
    }
  }, [cleanup, onTranscript]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    shouldTranscribeRef.current = true;
    recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    shouldTranscribeRef.current = false;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else cleanup();
  }, [cleanup]);

  return {
    isSupported: voiceRecordingSupported(),
    isRecording,
    isTranscribing,
    isBusy: isRecording || isTranscribing,
    error,
    setError,
    start,
    stop,
    cancel,
  };
}
