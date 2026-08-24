// Discord plugin module implements gateway rate limit behavior.
const GATEWAY_SEND_LIMIT = 120;
const GATEWAY_SEND_WINDOW_MS = 60_000;
const GATEWAY_SEND_QUEUE_LIMIT = GATEWAY_SEND_LIMIT;

type QueuedGatewaySend = {
  payload: string;
};

type GatewaySendQueueOverflow = {
  droppedEvents: number;
  maxQueuedEvents: number;
  policy: "drop-oldest";
  queuedEvents: number;
};

export class GatewaySendLimiter {
  private outboundSendTimestamps: number[] = [];
  private outboundQueue: QueuedGatewaySend[] = [];
  private outboundFlushTimer?: NodeJS.Timeout;
  private droppedEvents = 0;
  private overflowWarningEmitted = false;

  constructor(
    private sendNow: (payload: string) => void,
    private emitError: (error: Error) => void,
    private emitOverflowWarning: (warning: GatewaySendQueueOverflow) => void,
  ) {}

  send(serialized: string, options?: { critical?: boolean }): void {
    if (options?.critical || this.canSend(Date.now())) {
      this.sendSerialized(serialized);
      return;
    }
    let shouldEmitOverflowWarning = false;
    // Keep the newest deferred state within one additional send window. Warn once per
    // saturation episode so an overload cannot turn into a synchronous log flood.
    if (this.outboundQueue.length >= GATEWAY_SEND_QUEUE_LIMIT) {
      this.outboundQueue.shift();
      this.droppedEvents += 1;
      if (!this.overflowWarningEmitted) {
        this.overflowWarningEmitted = true;
        shouldEmitOverflowWarning = true;
      }
    }
    this.outboundQueue.push({ payload: serialized });
    if (shouldEmitOverflowWarning) {
      this.emitOverflowWarning({
        droppedEvents: this.droppedEvents,
        maxQueuedEvents: GATEWAY_SEND_QUEUE_LIMIT,
        policy: "drop-oldest",
        queuedEvents: this.outboundQueue.length,
      });
    }
    this.scheduleFlush();
  }

  clear(): void {
    if (this.outboundFlushTimer) {
      clearTimeout(this.outboundFlushTimer);
      this.outboundFlushTimer = undefined;
    }
    this.outboundQueue = [];
    this.droppedEvents = 0;
    this.overflowWarningEmitted = false;
  }

  getStatus() {
    const now = Date.now();
    this.pruneWindow(now);
    const oldest = this.outboundSendTimestamps[0] ?? now;
    return {
      remainingEvents: Math.max(0, GATEWAY_SEND_LIMIT - this.outboundSendTimestamps.length),
      resetTime:
        this.outboundSendTimestamps.length > 0
          ? oldest + GATEWAY_SEND_WINDOW_MS
          : now + GATEWAY_SEND_WINDOW_MS,
      currentEventCount: this.outboundSendTimestamps.length,
      queuedEvents: this.outboundQueue.length,
      droppedEvents: this.droppedEvents,
    };
  }

  private pruneWindow(now: number): void {
    const windowStart = now - GATEWAY_SEND_WINDOW_MS;
    while (
      this.outboundSendTimestamps.length > 0 &&
      (this.outboundSendTimestamps[0] ?? 0) <= windowStart
    ) {
      this.outboundSendTimestamps.shift();
    }
  }

  private canSend(now: number): boolean {
    this.pruneWindow(now);
    return this.outboundSendTimestamps.length < GATEWAY_SEND_LIMIT;
  }

  private sendSerialized(serialized: string): void {
    this.outboundSendTimestamps.push(Date.now());
    this.sendNow(serialized);
  }

  private scheduleFlush(): void {
    if (this.outboundFlushTimer || this.outboundQueue.length === 0) {
      return;
    }
    const now = Date.now();
    this.pruneWindow(now);
    const oldest = this.outboundSendTimestamps[0] ?? now;
    const delayMs =
      this.outboundSendTimestamps.length >= GATEWAY_SEND_LIMIT
        ? Math.max(0, oldest + GATEWAY_SEND_WINDOW_MS - now)
        : 0;
    this.outboundFlushTimer = setTimeout(() => {
      this.outboundFlushTimer = undefined;
      this.flush();
    }, delayMs);
    this.outboundFlushTimer.unref?.();
  }

  private flush(): void {
    while (this.outboundQueue.length > 0 && this.canSend(Date.now())) {
      const queued = this.outboundQueue.shift();
      if (!queued) {
        continue;
      }
      try {
        this.sendSerialized(queued.payload);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error), { cause: error }));
        this.clear();
        return;
      }
    }
    if (this.outboundQueue.length < GATEWAY_SEND_QUEUE_LIMIT) {
      this.overflowWarningEmitted = false;
    }
    this.scheduleFlush();
  }
}
