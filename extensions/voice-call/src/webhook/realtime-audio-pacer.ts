// Realtime telephony audio pacing for mulaw streams.

const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
const TELEPHONY_CHUNK_MS = 20;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;

/** Queue item sent over the realtime provider media stream. */
type RealtimeAudioQueueItem =
  | {
      chunk: Buffer;
      durationMs: number;
      type: "audio";
    }
  | {
      name: string;
      type: "mark";
    };

/** WebSocket send callback for realtime audio frames. */
type RealtimeAudioSend = (message: string) => boolean;

/** Provider-specific serializer for media, clear, and mark frames. */
interface RealtimeAudioSerializer {
  media(payloadBase64: string): string;
  clear(): string;
  mark(name: string): string;
}

/** Paces outgoing mulaw audio frames at telephony cadence. */
export class RealtimeAudioPacer {
  private queue: RealtimeAudioQueueItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedAudioBytes = 0;
  private closed = false;

  constructor(
    private readonly params: {
      maxQueuedAudioBytes?: number;
      onBackpressure?: () => void;
      send: RealtimeAudioSend;
      serializer: RealtimeAudioSerializer;
    },
  ) {}

  /** Queue mulaw audio and split it into 20ms-ish telephony chunks. */
  sendAudio(muLaw: Buffer): void {
    if (this.closed || muLaw.length === 0) {
      return;
    }
    const maxQueuedAudioBytes = this.params.maxQueuedAudioBytes ?? DEFAULT_MAX_QUEUED_AUDIO_BYTES;
    for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
      const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      if (this.queuedAudioBytes + chunk.length > maxQueuedAudioBytes) {
        this.failBackpressure();
        return;
      }
      this.queue.push({
        type: "audio",
        chunk,
        durationMs: Math.max(1, Math.round((chunk.length / TELEPHONY_SAMPLE_RATE) * 1000)),
      });
      this.queuedAudioBytes += chunk.length;
    }
    this.ensurePump();
  }

  /** Queue a provider mark frame after prior audio frames. */
  sendMark(name: string): void {
    if (this.closed || !name) {
      return;
    }
    this.queue.push({ type: "mark", name });
    this.ensurePump();
  }

  /** Clear queued audio and notify the provider stream. */
  clearAudio(): number {
    if (this.closed) {
      return 0;
    }
    const clearedAudioBytes = this.queuedAudioBytes;
    this.clearTimer();
    this.queue = [];
    this.queuedAudioBytes = 0;
    this.params.send(this.params.serializer.clear());
    return clearedAudioBytes;
  }

  /** True while queued audio or a paced send timer can still reach the telephony stream. */
  hasPendingAudio(): boolean {
    return !this.closed && (this.queuedAudioBytes > 0 || this.timer !== null);
  }

  /** Stop sending and discard queued frames. */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.queue = [];
    this.queuedAudioBytes = 0;
  }

  /** Clear the scheduled pump timer. */
  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Start the pump when queued work exists and no timer is active. */
  private ensurePump(): void {
    if (!this.timer) {
      this.pump();
    }
  }

  /** Close the pacer and notify the caller about queued-audio backpressure. */
  private failBackpressure(): void {
    this.close();
    this.params.onBackpressure?.();
  }

  /** Send one queued item and schedule the next send based on audio duration. */
  private pump(): void {
    this.timer = null;
    if (this.closed) {
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      return;
    }

    let delayMs = 0;
    let sent;
    if (item.type === "audio") {
      this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.chunk.length);
      sent = this.params.send(this.params.serializer.media(item.chunk.toString("base64")));
      delayMs = item.durationMs || TELEPHONY_CHUNK_MS;
    } else {
      sent = this.params.send(this.params.serializer.mark(item.name));
    }

    if (!sent) {
      this.queue = [];
      this.queuedAudioBytes = 0;
      return;
    }
    if (this.queue.length > 0) {
      this.timer = setTimeout(() => this.pump(), delayMs);
    }
  }
}
