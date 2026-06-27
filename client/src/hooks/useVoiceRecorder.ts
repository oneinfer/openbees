import { useCallback, useRef, useState } from 'react';
import { releaseActivitySpeechInput, suppressActivitySpeechInput, transcribeAudio } from '../lib/api';
import { toErrorMessage } from '../lib/format';

const TARGET_SAMPLE_RATE = 16_000;

type AudioContextConstructor = typeof AudioContext;

type WindowWithWebAudio = Window & {
  webkitAudioContext?: AudioContextConstructor;
};

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as WindowWithWebAudio).webkitAudioContext ?? null;
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function mergeChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function resampleLinear(samples: Float32Array, fromSampleRate: number, toSampleRate: number): Float32Array {
  if (fromSampleRate === toSampleRate) return samples;
  const nextLength = Math.max(1, Math.round(samples.length * toSampleRate / fromSampleRate));
  const next = new Float32Array(nextLength);
  const ratio = (samples.length - 1) / Math.max(1, nextLength - 1);

  for (let i = 0; i < nextLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    next[i] = samples[left] + (samples[right] - samples[left]) * fraction;
  }

  return next;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function wavBlobFromChunks(chunks: Float32Array[], sourceSampleRate: number): Blob | null {
  if (chunks.length === 0 || sourceSampleRate <= 0) return null;
  const merged = mergeChunks(chunks);
  if (merged.length === 0) return null;
  const resampled = resampleLinear(merged, sourceSampleRate, TARGET_SAMPLE_RATE);
  return encodeWav(resampled, TARGET_SAMPLE_RATE);
}

export function voiceRecordingSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && !!audioContextConstructor();
}

export function useVoiceRecorder(
  onTranscript: (text: string) => void,
  onAudio?: (audio: Blob) => Promise<void>,
) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(0);
  const shouldTranscribeRef = useRef(false);
  const activitySuppressionTokenRef = useRef<string | null>(null);

  const releaseActivitySuppression = useCallback(() => {
    const token = activitySuppressionTokenRef.current;
    activitySuppressionTokenRef.current = null;
    if (token) void releaseActivitySpeechInput(token).catch(() => undefined);
  }, []);

  const cleanup = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close().catch(() => undefined);
    }
    audioContextRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    chunksRef.current = [];
    sampleRateRef.current = 0;
    setIsRecording(false);
  }, []);

  const finishRecording = useCallback((shouldTranscribe: boolean) => {
    const chunks = chunksRef.current;
    const sampleRate = sampleRateRef.current;
    releaseActivitySuppression();
    cleanup();

    if (!shouldTranscribe) return;

    const audio = wavBlobFromChunks(chunks, sampleRate);
    if (!audio) {
      setError('No audio was recorded. Check your microphone input and try again.');
      return;
    }

    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (sampleRate > 0 && totalSamples / sampleRate < 0.5) {
      setError('Recording too short. Hold the button while speaking.');
      return;
    }

    setIsTranscribing(true);
    const run = onAudio
      ? onAudio(audio)
      : transcribeAudio(audio).then((result) => {
        const text = result.text.trim();
        if (text) onTranscript(text);
        else setError('No speech was detected.');
      });

    run
      .catch((err) => {
        setError(toErrorMessage(err, 'Failed to transcribe audio'));
      })
      .finally(() => setIsTranscribing(false));
  }, [cleanup, onAudio, onTranscript, releaseActivitySuppression]);

  const start = useCallback(async () => {
    if (!voiceRecordingSupported()) {
      setError('Voice recording is not supported in this browser.');
      return;
    }

    setError(null);

    const suppression = await suppressActivitySpeechInput('browser voice input', 180).catch(() => null);
    activitySuppressionTokenRef.current = suppression?.token ?? null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioContextCtor = audioContextConstructor();
      if (!AudioContextCtor) throw new Error('Web Audio recording is not supported in this browser.');

      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      if (audioContext.state === 'suspended') await audioContext.resume();

      audioContextRef.current = audioContext;
      sourceRef.current = source;
      processorRef.current = processor;
      chunksRef.current = [];
      sampleRateRef.current = audioContext.sampleRate;
      shouldTranscribeRef.current = true;

      processor.onaudioprocess = (event) => {
        if (!shouldTranscribeRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(input));
        event.outputBuffer.getChannelData(0).fill(0);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      setIsRecording(true);
    } catch (err) {
      releaseActivitySuppression();
      cleanup();
      setError(toErrorMessage(err, 'Microphone access failed'));
    }
  }, [cleanup, releaseActivitySuppression]);

  const stop = useCallback(() => {
    if (!isRecording) return;
    shouldTranscribeRef.current = true;
    finishRecording(true);
  }, [finishRecording, isRecording]);

  const cancel = useCallback(() => {
    shouldTranscribeRef.current = false;
    finishRecording(false);
  }, [finishRecording]);

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
