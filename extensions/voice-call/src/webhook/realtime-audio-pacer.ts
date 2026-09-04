// Realtime telephony audio pacing for mulaw streams.

const TELEPHONY_SAMPLE_RATE = 8_000;
const TELEPHONY_CHUNK_BYTES = 160;
// The lead absorbs event-loop timer lateness and network jitter in the telephony edge buffer.
// Barge-in clear flushes both queues, so this cushion does not add interruption latency.
const LEAD_MS = 160;
const PLAYBACK_MARK_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_QUEUED_AUDIO_BYTES = TELEPHONY_SAMPLE_RATE * 120;
const QUEUE_COMPACT_HEAD_THRESHOLD = 256;

export type RealtimeAudioDrainResult = "played" | "interrupted" | "timed-out";

/** Queue item sent over the realtime provider media stream. */
type RealtimeAudioQueueItem =
  | {
      chunk: Buffer;
      durationMs: number;
      type: "audio";
    }
  | {
      name: string;
      onSent?: () => void;
      type: "mark";
    };

type RealtimeAudioTerminalDrain = {
  completion: Promise<RealtimeAudioDrainResult>;
  markName: string;
  markSent: boolean;
  resolve: (result: RealtimeAudioDrainResult) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
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
  private queueHead = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queuedAudioBytes = 0;
  private closed = false;
  private streamClockMs: number | null = null;
  private terminalDrain: RealtimeAudioTerminalDrain | null = null;

  constructor(
    private readonly params: {
      maxQueuedAudioBytes?: number;
      onBackpressure?: () => void;
      send: RealtimeAudioSend;
      serializer: RealtimeAudioSerializer;
    },
  ) {}

  /** Queue mulaw audio and split it into 20ms-ish telephony chunks. */
  sendAudio(muLaw: Buffer): boolean {
    if (this.closed || this.terminalDrain || muLaw.length === 0) {
      return false;
    }
    const maxQueuedAudioBytes = this.params.maxQueuedAudioBytes ?? DEFAULT_MAX_QUEUED_AUDIO_BYTES;
    for (let offset = 0; offset < muLaw.length; offset += TELEPHONY_CHUNK_BYTES) {
      const chunk = Buffer.from(muLaw.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      if (this.queuedAudioBytes + chunk.length > maxQueuedAudioBytes) {
        this.failBackpressure();
        return false;
      }
      this.queue.push({
        type: "audio",
        chunk,
        durationMs: chunk.length / 8,
      });
      this.queuedAudioBytes += chunk.length;
    }
    this.ensurePump();
    return true;
  }

  /** Queue a provider mark frame after prior audio frames. */
  sendMark(name: string): void {
    if (this.closed || this.terminalDrain || !name) {
      return;
    }
    this.queue.push({ type: "mark", name });
    this.ensurePump();
  }

  /** Stop accepting output and wait until the provider plays everything before a terminal mark. */
  beginTerminalDrain(markName: string): Promise<RealtimeAudioDrainResult> {
    if (this.terminalDrain) {
      return this.terminalDrain.completion;
    }
    if (this.closed || !markName) {
      return Promise.resolve("interrupted");
    }

    let resolve!: (result: RealtimeAudioDrainResult) => void;
    const completion = new Promise<RealtimeAudioDrainResult>((settle) => {
      resolve = settle;
    });
    const drain: RealtimeAudioTerminalDrain = {
      completion,
      markName,
      markSent: false,
      resolve,
      settled: false,
      timer: null,
    };
    this.terminalDrain = drain;
    this.queue.push({
      type: "mark",
      name: markName,
      onSent: () => this.armTerminalDrainTimeout(drain),
    });
    this.ensurePump();
    return completion;
  }

  /** Match a provider playback acknowledgment to the active terminal mark. */
  acknowledgeMark(name?: string): void {
    const drain = this.terminalDrain;
    if (!drain || !drain.markSent || name !== drain.markName) {
      return;
    }
    this.settleTerminalDrain(drain, "played");
  }

  /** Re-open output if the carrier could not complete the requested hangup. */
  resumeAfterTerminalDrain(): void {
    const drain = this.terminalDrain;
    if (!drain) {
      return;
    }
    this.settleTerminalDrain(drain, "interrupted");
    this.terminalDrain = null;
  }

  /** Clear queued audio and notify the provider stream. */
  clearAudio(): number {
    if (this.closed) {
      return 0;
    }
    const clearedAudioBytes = this.queuedAudioBytes;
    this.interruptTerminalDrain();
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
    this.interruptTerminalDrain();
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
        this.interruptTerminalDrain();
        this.resetQueue();
        this.queuedAudioBytes = 0;
        this.streamClockMs = null;
        return;
      }
      if (item.type === "mark") {
        item.onSent?.();
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

  private armTerminalDrainTimeout(drain: RealtimeAudioTerminalDrain): void {
    if (this.terminalDrain !== drain || drain.settled) {
      return;
    }
    drain.markSent = true;
    drain.timer = setTimeout(() => {
      this.settleTerminalDrain(drain, "timed-out");
    }, PLAYBACK_MARK_TIMEOUT_MS);
    drain.timer.unref?.();
  }

  private interruptTerminalDrain(): void {
    const drain = this.terminalDrain;
    if (drain) {
      this.settleTerminalDrain(drain, "interrupted");
    }
  }

  private settleTerminalDrain(
    drain: RealtimeAudioTerminalDrain,
    result: RealtimeAudioDrainResult,
  ): void {
    if (drain.settled) {
      return;
    }
    drain.settled = true;
    if (drain.timer) {
      clearTimeout(drain.timer);
      drain.timer = null;
    }
    drain.resolve(result);
  }
}
