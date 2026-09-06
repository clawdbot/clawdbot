import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
  ThinkingContent,
} from "../types.js";

// Only the mutation owner can prove an append: transport indices and mutable
// partial snapshots alone do not establish that their previous prefix survived.
const thinkingAppends = new WeakMap<
  ThinkingContent,
  { before: string; after: string; delta: string }
>();

/** Package-internal mutation fact for native reasoning projection. */
export function appendAssistantThinking(block: ThinkingContent, delta: string): void {
  const before = block.thinking;
  block.thinking += delta;
  thinkingAppends.set(block, { before, after: block.thinking, delta });
}

/** Returns only an append whose current and previously observed snapshots still match. */
export function readAssistantThinkingAppend(
  block: ThinkingContent,
  previous: string,
): string | undefined {
  const append = thinkingAppends.get(block);
  return append?.before === previous && append.after === block.thinking ? append.delta : undefined;
}

/** Generic async-iterable event stream with a separately awaited final result. */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: (T | undefined)[] = [];
  private queueHead = 0;
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  protected done = false;
  private resultSettled = false;
  private finalResultPromise: Promise<R>;
  // Promise invokes its executor before construction returns.
  private resolveFinalResult!: (result: R) => void;
  private rejectFinalResult!: (error: Error) => void;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
  }

  push(event: T): void {
    if (this.done) {
      return;
    }

    if (this.isComplete(event)) {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      // A producer that ends without a terminal event or explicit result would
      // otherwise leave result() pending forever; awaiting consumers dead-end
      // silently for the whole run budget. Reject loudly instead. The
      // pre-attached catch keeps iterate-only consumers (which legitimately
      // never call result()) free of unhandled rejections.
      this.resultSettled = true;
      void this.finalResultPromise.catch(() => {});
      this.rejectFinalResult(
        new Error("event stream ended without a terminal event or final result"),
      );
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      if (!waiter) {
        break;
      }
      waiter({ value: undefined as unknown, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queueHead < this.queue.length) {
        const event = this.queue[this.queueHead] as T;
        // The consumer owns this event now; compaction must not delay payload release.
        this.queue[this.queueHead] = undefined;
        this.queueHead += 1;
        // Compact only after a substantial consumed prefix reaches half the
        // backing array, keeping dequeue amortized O(1) when consumers lag.
        if (this.queueHead >= 1024 && this.queueHead * 2 >= this.queue.length) {
          this.queue = this.queue.slice(this.queueHead);
          this.queueHead = 0;
        }
        yield event;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiting.push(resolve);
        });
        if (result.done) {
          return;
        }
        yield result.value;
      }
    }
  }

  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

/** Assistant-message event stream that resolves on done/error terminal events. */
export class AssistantMessageEventStream
  extends EventStream<AssistantMessageEvent, AssistantMessage>
  implements AssistantMessageEventStreamContract
{
  private activeThinkingBlocks?: Set<ThinkingContent>;

  override push(event: AssistantMessageEvent): void {
    if (event.type === "thinking_delta" || event.type === "thinking_end") {
      const block = event.partial.content[event.contentIndex];
      if (block?.type === "thinking") {
        if (this.done || event.type === "thinking_end") {
          thinkingAppends.delete(block);
          this.activeThinkingBlocks?.delete(block);
        } else if (thinkingAppends.has(block)) {
          (this.activeThinkingBlocks ??= new Set()).add(block);
        }
      }
    }
    if (event.type === "done" || event.type === "error") {
      this.clearThinkingAppends(event.type === "done" ? event.message : event.error);
    }
    super.push(event);
  }

  override end(result?: AssistantMessage): void {
    this.clearThinkingAppends(result);
    super.end(result);
  }

  private clearThinkingAppends(message?: AssistantMessage): void {
    // Deferred transports can withhold all deltas until terminal classification.
    for (const block of message?.content ?? []) {
      if (block.type === "thinking") {
        thinkingAppends.delete(block);
      }
    }
    // Historical blocks survive in transcripts. Do not let their WeakMap keys
    // retain a previous full reasoning string after the stream releases it.
    for (const block of this.activeThinkingBlocks ?? []) {
      thinkingAppends.delete(block);
    }
    this.activeThinkingBlocks = undefined;
  }

  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        } else if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}

/** Creates an assistant-message stream for provider and plugin adapters. */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
