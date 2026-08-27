// Realtime telephony audio pacing for mulaw streams.

const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
// The lead absorbs event-loop timer lateness and network jitter in the telephony edge buffer.
// Barge-in clear flushes both queues, so this cushion does not add interruption latency.
const LEAD_MS = 160;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;
const QUEUE_COMPACT_HEAD_THRESHOLD = 256;

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

/** Carrier send callback for realtime audio frames. */
type RealtimeAudioSend<TMessage> = (message: TMessage) => boolean;

/** Provider-specific serializer for media, clear, and mark frames. */
export interface RealtimeAudioSerializer<TMessage = string> {
  media(payloadBase64: string): TMessage;
  clear(): TMessage;
  mark(name: string): TMessage;
}

/** Paces outgoing mulaw audio frames at telephony cadence. */
export class RealtimeAudioPacer<TMessage = string> {
  private queue: RealtimeAudioQueueItem[] = [];
  private queueHead = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedAudioBytes = 0;
  private closed = false;
  private streamClockMs: number | null = null;

  constructor(
    private readonly params: {
      maxQueuedAudioBytes?: number;
      onBackpressure?: () => void;
      onMarkSent?: (name: string) => void;
      send: RealtimeAudioSend<TMessage>;
      serializer: RealtimeAudioSerializer<TMessage>;
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
        durationMs: chunk.length / 8,
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
    this.resetQueue();
    this.queuedAudioBytes = 0;
    this.streamClockMs = null;
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
    this.resetQueue();
    this.queuedAudioBytes = 0;
    this.streamClockMs = null;
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

  private get pendingQueueSize(): number {
    return Math.max(0, this.queue.length - this.queueHead);
  }

  /** Take one queued item without shifting the remaining paced-audio backlog. */
  private takeNextItem(): RealtimeAudioQueueItem | undefined {
    if (this.queueHead >= this.queue.length) {
      this.resetQueue();
      return undefined;
    }
    const item = this.queue[this.queueHead];
    this.queueHead += 1;
    if (this.queueHead >= this.queue.length) {
      this.resetQueue();
    } else if (
      this.queueHead > QUEUE_COMPACT_HEAD_THRESHOLD &&
      this.queueHead * 2 > this.queue.length
    ) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
    return item;
  }

  private resetQueue(): void {
    this.queue.length = 0;
    this.queueHead = 0;
  }

  /** Fill the provider playout cushion, then wake at the next timeline boundary. */
  private pump(): void {
    this.timer = null;
    if (this.closed) {
      return;
    }
    const now = performance.now();
    this.streamClockMs ??= now;

    while (this.pendingQueueSize > 0 && this.streamClockMs < now + LEAD_MS) {
      const item = this.takeNextItem();
      if (!item) {
        break;
      }

      const sent =
        item.type === "audio"
          ? this.sendAudioItem(item)
          : this.params.send(this.params.serializer.mark(item.name));
      if (!sent) {
        this.resetQueue();
        this.queuedAudioBytes = 0;
        this.streamClockMs = null;
        return;
      }
      if (item.type === "mark") {
        this.params.onMarkSent?.(item.name);
      }
    }

    if (this.pendingQueueSize === 0) {
      this.streamClockMs = null;
      return;
    }
    const delayMs = Math.max(1, this.streamClockMs - LEAD_MS - performance.now());
    this.timer = setTimeout(() => this.pump(), delayMs);
  }

  private sendAudioItem(item: Extract<RealtimeAudioQueueItem, { type: "audio" }>): boolean {
    this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.chunk.length);
    const sent = this.params.send(this.params.serializer.media(item.chunk.toString("base64")));
    this.streamClockMs = (this.streamClockMs ?? performance.now()) + item.durationMs;
    return sent;
  }
}
