// Discord plugin module implements event queue behavior.
export type DiscordEventQueueOptions = {
  maxQueueSize?: number;
  maxConcurrency?: number;
  listenerTimeout?: number;
  slowListenerThreshold?: number;
};

type DiscordEventQueueJob = {
  eventType: string;
  listenerName: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type DiscordEventQueueDispatchOutcome = "completed" | "failed" | "timed-out";

type DiscordEventQueueMetrics = {
  queueSize: number;
  processing: number;
  processed: number;
  dropped: number;
  timeouts: number;
  maxQueueSize: number;
  maxConcurrency: number;
};

const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_CONCURRENCY = 50;
const DEFAULT_LISTENER_TIMEOUT_MS = 120_000;
const DEFAULT_SLOW_LISTENER_THRESHOLD_MS = 30_000;

export class DiscordEventQueue {
  private readonly options: Required<DiscordEventQueueOptions>;
  private readonly queue: DiscordEventQueueJob[] = [];
  private queueHead = 0;
  private processing = 0;
  private processedCount = 0;
  private droppedCount = 0;
  private timeoutCount = 0;

  constructor(options: DiscordEventQueueOptions = {}) {
    this.options = {
      maxQueueSize: normalizePositiveInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE),
      maxConcurrency: normalizePositiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
      listenerTimeout: normalizePositiveInteger(
        options.listenerTimeout,
        DEFAULT_LISTENER_TIMEOUT_MS,
      ),
      slowListenerThreshold: normalizePositiveInteger(
        options.slowListenerThreshold,
        DEFAULT_SLOW_LISTENER_THRESHOLD_MS,
      ),
    };
  }

  enqueue(params: Omit<DiscordEventQueueJob, "resolve" | "reject">): Promise<void> {
    if (this.pendingQueueSize >= this.options.maxQueueSize) {
      this.droppedCount += 1;
      return Promise.reject(
        new Error(
          `Discord event queue is full for ${params.eventType}; maxQueueSize=${this.options.maxQueueSize}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ ...params, resolve, reject });
      this.processNext();
    });
  }

  getMetrics(): DiscordEventQueueMetrics {
    return {
      queueSize: this.pendingQueueSize,
      processing: this.processing,
      processed: this.processedCount,
      dropped: this.droppedCount,
      timeouts: this.timeoutCount,
      maxQueueSize: this.options.maxQueueSize,
      maxConcurrency: this.options.maxConcurrency,
    };
  }

  private get pendingQueueSize(): number {
    return Math.max(0, this.queue.length - this.queueHead);
  }

  private takeNextJob(): DiscordEventQueueJob | undefined {
    if (this.queueHead >= this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
      return undefined;
    }
    const job = this.queue[this.queueHead];
    this.queueHead += 1;
    if (this.queueHead >= this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    } else if (this.queueHead > 256 && this.queueHead * 2 > this.queue.length) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
    return job;
  }

  private processNext(): void {
    while (this.processing < this.options.maxConcurrency && this.pendingQueueSize > 0) {
      const job = this.takeNextJob();
      if (!job) {
        return;
      }
      this.processing += 1;
      const listenerPromise = Promise.resolve().then(() => job.run());
      const runJobPromise = this.runJob(job, listenerPromise);
      void runJobPromise.then(job.resolve, job.reject).finally(() => {
        // Processed counts externally settled dispatches; a timed-out listener
        // can still retain its concurrency slot until its own settlement.
        this.processedCount += 1;
      });
      // A timeout settles enqueue but cannot cancel the listener. Hold its slot
      // until actual settlement or late listeners can exceed maxConcurrency.
      void Promise.allSettled([runJobPromise, listenerPromise]).then(
        ([dispatchResult, listenerResult]) => {
          if (
            dispatchResult.status === "fulfilled" &&
            dispatchResult.value === "timed-out" &&
            listenerResult.status === "rejected"
          ) {
            console.error(
              `[EventQueue] Listener ${job.listenerName} failed after timeout for event ${job.eventType}:`,
              listenerResult.reason,
            );
          }
          this.processing -= 1;
          this.processNext();
        },
      );
    }
  }

  private async runJob(
    job: DiscordEventQueueJob,
    listenerPromise: Promise<void>,
  ): Promise<DiscordEventQueueDispatchOutcome> {
    const startedAt = Date.now();
    try {
      await this.runWithTimeout(listenerPromise);
      this.logSlowListener(job, Date.now() - startedAt);
      return "completed";
    } catch (error) {
      if (isListenerTimeoutError(error)) {
        this.timeoutCount += 1;
        console.error(
          `[EventQueue] Listener ${job.listenerName} timed out after ${this.options.listenerTimeout}ms for event ${job.eventType}`,
        );
        return "timed-out";
      }
      console.error(
        `[EventQueue] Listener ${job.listenerName} failed for event ${job.eventType}:`,
        error,
      );
      return "failed";
    }
  }

  private async runWithTimeout(listenerPromise: Promise<void>): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        listenerPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(createListenerTimeoutError(this.options.listenerTimeout));
          }, this.options.listenerTimeout);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private logSlowListener(job: DiscordEventQueueJob, durationMs: number): void {
    if (durationMs < this.options.slowListenerThreshold) {
      return;
    }
    console.warn(
      `[EventQueue] Slow listener detected: ${job.listenerName} took ${durationMs}ms for event ${job.eventType}`,
    );
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function createListenerTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Listener timeout after ${timeoutMs}ms`);
  error.name = "DiscordEventQueueListenerTimeoutError";
  return error;
}

function isListenerTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "DiscordEventQueueListenerTimeoutError";
}
