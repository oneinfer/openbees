const SPEECH_SEGMENT_PATTERN = /(.+?[.!?])(?:\s+|$)/s;

function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const samples = new Float32Array(Math.floor(binary.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    const signed = (hi << 8) | lo;
    const value = signed >= 0x8000 ? signed - 0x10000 : signed;
    samples[i] = Math.max(-1, Math.min(1, value / 0x8000));
  }
  return samples;
}

export class AudioQueue {
  private context: AudioContext | null = null;
  private nextStartTime = 0;

  async play(base64: string, sampleRate: number): Promise<void> {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Audio playback is not supported in this browser.');
    if (!this.context || this.context.state === 'closed') this.context = new AudioContextCtor();
    if (this.context.state === 'suspended') await this.context.resume();

    const samples = pcm16Base64ToFloat32(base64);
    if (samples.length === 0) return;

    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    const startAt = Math.max(this.context.currentTime + 0.03, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  reset(): void {
    this.nextStartTime = this.context?.currentTime ?? 0;
  }

  close(): void {
    const context = this.context;
    this.context = null;
    this.nextStartTime = 0;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}

export class BrowserSpeechQueue {
  private buffer = '';

  available(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  acceptText(text: string, forceFlush = false): void {
    if (!this.available()) return;
    this.buffer += text;
    this.flushReadySegments(forceFlush);
  }

  reset(): void {
    this.buffer = '';
    if (this.available()) window.speechSynthesis.cancel();
  }

  private flushReadySegments(forceFlush: boolean): void {
    while (this.buffer.trim()) {
      const text = this.buffer.trim();
      const match = text.match(SPEECH_SEGMENT_PATTERN);
      if (match?.index === 0 && match[1]) {
        this.speak(match[1]);
        this.buffer = text.slice(match[0].length).trim();
        continue;
      }
      if (forceFlush || text.length >= 320) {
        const splitAt = forceFlush ? text.length : Math.max(120, text.lastIndexOf(' ', 320));
        this.speak(text.slice(0, splitAt));
        this.buffer = text.slice(splitAt).trim();
        continue;
      }
      this.buffer = text;
      return;
    }
  }

  private speak(text: string): void {
    const segment = text.trim();
    if (!segment) return;
    const utterance = new SpeechSynthesisUtterance(segment);
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }
}
