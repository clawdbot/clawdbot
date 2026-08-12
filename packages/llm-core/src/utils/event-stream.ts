// LLM Core module implements event stream behavior.
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
} from "../types.js";

/** Generic async-iterable event stream with a separately awaited final result. */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private queueHead = 0;
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;
  private resultSettled = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult: (result: R) => void;
  private rejectFinalResult: (error: Error) => void;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    const resolvers: Array<(result: R) => void> = [];
    const rejecters: Array<(error: Error) => void> = [];
    this.finalResultPromise = new Promise((resolve, reject) => {
      resolvers.push(resolve);
      rejecters.push(reject);
    });
    const resolveFinalResult = resolvers.at(0);
    const rejectFinalResult = rejecters.at(0);
    if (!resolveFinalResult || !rejectFinalResult) {
      throw new Error("event stream result promise did not initialize its resolver");
    }
    this.resolveFinalResult = resolveFinalResult;
    this.rejectFinalResult = rejectFinalResult;
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
