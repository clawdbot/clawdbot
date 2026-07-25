// Opencode Go stream termination wrapper tests cover provider-owned raw SSE
// boundary behavior for stalled OpenAI-compatible streams.
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpencodeGoStalledStreamWrapper } from "./stream-termination.js";

type AnyEvent = AssistantMessageEvent;
type StreamLike = AssistantMessageEventStreamContract;
type ProviderStreamFn = Parameters<typeof createOpencodeGoStalledStreamWrapper>[0];
type ProviderModel = Parameters<ProviderStreamFn>[0];
type ProviderContext = Parameters<ProviderStreamFn>[1];
type ProviderCallOptions = Parameters<ProviderStreamFn>[2];
type ErrorEvent = Extract<AnyEvent, { type: "error" }>;

function asProviderEvent(event: unknown): AnyEvent {
  return event as AnyEvent;
}

function asProviderModel(model: unknown): ProviderModel {
  return model as ProviderModel;
}

interface FakeStreamController {
  emit(event: AnyEvent): void;
  end(): void;
}

function createFakeBaseStream(): {
  stream: StreamLike;
  controller: FakeStreamController;
  getReturnCalls: () => number;
} {
  const queued: IteratorResult<AnyEvent>[] = [];
  const waiters: ((result: IteratorResult<AnyEvent>) => void)[] = [];
  let finished = false;
  let returnCalls = 0;

  const iterator: AsyncIterator<AnyEvent> = {
    next(): Promise<IteratorResult<AnyEvent>> {
      if (queued.length > 0) {
        return Promise.resolve(queued.shift()!);
      }
      if (finished) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    return(): Promise<IteratorResult<AnyEvent>> {
      returnCalls += 1;
      finished = true;
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined, done: true });
      }
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  const stream: StreamLike = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    push() {
      // unused: the wrapper pushes its own events into a separate stream.
    },
    end() {
      // unused: the wrapper ends its own stream.
    },
    result() {
      return Promise.reject(new Error("fake base stream result not used"));
    },
  };

  const controller: FakeStreamController = {
    emit(event: AnyEvent) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: event, done: false });
      } else {
        queued.push({ value: event, done: false });
      }
    },
    end() {
      finished = true;
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined, done: true });
      }
    },
  };

  return { stream, controller, getReturnCalls: () => returnCalls };
}

describe("createOpencodeGoStalledStreamWrapper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts underlying stream when progress stalls after first delta (raw SSE boundary)", async () => {
    // Arrange: a fake base stream that emits a start + one text_delta, then stalls.
    const { stream: baseStream, controller } = createFakeBaseStream();
    void baseStream;
    let abortCalled = false;
    const capturedSignals: AbortSignal[] = [];

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    // Drain wrapper events in the background.
    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    // Emit a start + one text delta — that proves the provider side has produced tokens.
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stopReason: undefined,
    };
    controller.emit(asProviderEvent({ type: "start", partial }));
    controller.emit(
      asProviderEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "hi",
        partial,
      }),
    );

    // Advance wall clock beyond idleTimeoutMs without any new progress.
    await vi.advanceTimersByTimeAsync(6_000);

    // Assert: wrapper called abort on its injected AbortController (forwarded as options.signal).
    expect(capturedSignals).toHaveLength(1);
    expect(abortCalled).toBe(true);

    // And it pushed a terminal error event to the downstream consumer.
    const terminal = received.find(
      (event): event is ErrorEvent => event.type === "error" && event.reason === "error",
    );
    expect(terminal).toBeDefined();
    expect(terminal?.error).toMatchObject({
      stopReason: "error",
      errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
    });

    // Cleanup: end base stream so consumer promise resolves.
    controller.end();
    await consumer;
  });

  it("uses a longer first-event timeout than the inter-event idle timeout", async () => {
    const { stream: baseStream } = createFakeBaseStream();
    let abortCalled = false;

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
      firstEventTimeoutMs: 10_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const consumer = (async () => {
      for await (const event of downstream) {
        void event;
      }
    })();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(abortCalled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(abortCalled).toBe(true);
    await consumer;
  });

  it("keeps the first-event window after an openai-completions synthetic start", async () => {
    const { stream: baseStream, controller } = createFakeBaseStream();
    let abortCalled = false;

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
      firstEventTimeoutMs: 10_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    const partial = {
      role: "assistant",
      content: [],
      stopReason: undefined,
    };
    controller.emit(asProviderEvent({ type: "start", partial }));

    await vi.advanceTimersByTimeAsync(6_000);
    expect(abortCalled).toBe(false);

    controller.emit(
      asProviderEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: {
          ...partial,
          content: [{ type: "text", text: "hello" }],
        },
      }),
    );
    controller.emit({
      type: "done",
      reason: "stop",
      message: {
        ...partial,
        content: [{ type: "text", text: "hello" }],
        stopReason: "stop",
      },
    } as AnyEvent);
    await consumer;

    expect(abortCalled).toBe(false);
    expect(received.some((event) => event.type === "text_delta")).toBe(true);
    expect(received.some((event) => event.type === "done")).toBe(true);
  });

  it("keeps the first-event window after synthetic block-start events until a provider delta", async () => {
    const { stream: baseStream, controller } = createFakeBaseStream();
    let abortCalled = false;

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
      firstEventTimeoutMs: 10_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: undefined,
    };
    controller.emit(asProviderEvent({ type: "start", partial }));
    controller.emit(asProviderEvent({ type: "text_start", contentIndex: 0, partial }));

    await vi.advanceTimersByTimeAsync(6_000);
    expect(abortCalled).toBe(false);

    const message = {
      ...partial,
      content: [{ type: "text", text: "hello" }],
      stopReason: "stop",
    };
    controller.emit({
      type: "text_delta",
      contentIndex: 0,
      delta: "hello",
      partial: message,
    } as AnyEvent);
    controller.emit({ type: "done", reason: "stop", message } as AnyEvent);
    await consumer;

    expect(abortCalled).toBe(false);
    expect(received.some((event) => event.type === "text_delta")).toBe(true);
    expect(received.some((event) => event.type === "done")).toBe(true);
  });

  it("honors explicit opencode-go provider request timeout above the wrapper idle default", async () => {
    const { stream: baseStream, controller } = createFakeBaseStream();
    let abortCalled = false;

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
      firstEventTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        asProviderModel({
          provider: "opencode-go",
          id: "deepseek-v4-flash",
          requestTimeoutMs: 10_000,
        }),
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const consumer = (async () => {
      for await (const event of downstream) {
        void event;
      }
    })();

    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "slow" }],
      stopReason: undefined,
    };
    controller.emit(asProviderEvent({ type: "start", partial }));

    await vi.advanceTimersByTimeAsync(6_000);
    expect(abortCalled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(abortCalled).toBe(true);
    await consumer;
  });

  it("preserves the provider-owned first-event timeout when core passes a shorter generic value", async () => {
    const { stream: baseStream, controller } = createFakeBaseStream();

    const underlying = vi.fn((_model, _context, _options) => baseStream);

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 120_000,
      firstEventTimeoutMs: 300_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        { firstEventTimeoutMs: 30_000 } as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const consumer = (async () => {
      for await (const event of downstream) {
        void event;
      }
    })();

    expect(underlying).toHaveBeenCalledTimes(1);
    expect(underlying.mock.calls[0]?.[2]).toMatchObject({
      firstEventTimeoutMs: 300_000,
    });

    controller.end();
    await consumer;
  });

  it("honors explicit opencode-go provider request timeout below wrapper defaults", async () => {
    const { stream: baseStream } = createFakeBaseStream();
    let abortCalled = false;

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
      firstEventTimeoutMs: 10_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        asProviderModel({
          provider: "opencode-go",
          id: "deepseek-v4-flash",
          requestTimeoutMs: 2_000,
        }),
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const consumer = (async () => {
      for await (const event of downstream) {
        void event;
      }
    })();

    await vi.advanceTimersByTimeAsync(2_500);
    expect(abortCalled).toBe(true);
    await consumer;
  });

  it("aborts and releases the underlying stream when no first event arrives", async () => {
    const { stream: baseStream, getReturnCalls } = createFakeBaseStream();
    let abortCalled = false;
    const capturedSignals: AbortSignal[] = [];

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    await vi.advanceTimersByTimeAsync(6_000);

    expect(capturedSignals).toHaveLength(1);
    expect(abortCalled).toBe(true);
    expect(getReturnCalls()).toBe(1);
    expect(received.some((event) => event.type === "error" && event.reason === "error")).toBe(true);

    await consumer;
  });

  it("aborts stream creation when the upstream stream promise never resolves", async () => {
    let abortCalled = false;

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return new Promise<StreamLike>(() => {
        // keep pending
      });
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    await vi.advanceTimersByTimeAsync(6_000);

    expect(abortCalled).toBe(true);
    expect(received.some((event) => event.type === "error" && event.reason === "error")).toBe(true);
    await consumer;
  });

  it("preserves caller abort reasons in the wrapped provider signal", async () => {
    const caller = new AbortController();
    const reason = new Error("caller stopped");
    const { stream: baseStream, controller } = createFakeBaseStream();
    let capturedSignal: AbortSignal | undefined;
    const underlying = vi.fn((_model, _context, options) => {
      capturedSignal = options?.signal;
      return baseStream;
    });
    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        { signal: caller.signal } as ProviderCallOptions,
      ),
    );
    caller.abort(reason);

    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe(reason);

    controller.end();
    if (downstream) {
      for await (const event of downstream) {
        void event;
      }
    }
  });

  it("preserves normal delayed usage-only completion without aborting", async () => {
    // Arrange: a fake base stream that streams a normal completion, including
    // a long quiet gap before the final usage-only delta — but well within the
    // idle timeout. The wrapper must not abort.
    const { stream: baseStream, controller } = createFakeBaseStream();
    void baseStream;
    let abortCalled = false;
    const capturedSignals: AbortSignal[] = [];

    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs: 5_000,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "deepseek-v4-flash" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stopReason: "stop",
    };
    controller.emit({ type: "start", partial } as AnyEvent);
    controller.emit({
      type: "text_delta",
      contentIndex: 0,
      delta: "hello",
      partial,
    } as AnyEvent);

    // Simulate a delayed final chunk after a short (sub-timeout) quiet gap.
    await vi.advanceTimersByTimeAsync(2_000);

    // Final completion event arrives before idle timeout fires.
    controller.emit({
      type: "done",
      reason: "stop",
      message: partial,
    } as AnyEvent);

    // Advance well past the idle timeout — wrapper should NOT have fired.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(abortCalled).toBe(false);

    // Downstream must contain all forwarded events including the done event.
    const doneEvent = received.find((event) => event.type === "done");
    expect(doneEvent).toBeDefined();

    // Cleanup
    controller.end();
    await consumer;
  });

  it("must NOT abort a live stream that keeps emitting block-boundary events between deltas", async () => {
    // Regression for https://github.com/openclaw/openclaw/issues/96518:
    // the idle timer must re-arm on block-boundary events (text_end,
    // thinking_end, toolcall_start, toolcall_end), not only on token
    // deltas. A stream that keeps producing boundary events between
    // deltas is demonstrably alive and must not be aborted.
    const { stream: baseStream, controller } = createFakeBaseStream();
    let abortCalled = false;
    const underlying = vi.fn((_model, _context, options) => {
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          abortCalled = true;
        });
      }
      return baseStream;
    });

    const idleTimeoutMs = 5_000;
    const wrapper = createOpencodeGoStalledStreamWrapper(underlying as ProviderStreamFn, {
      provider: "opencode-go",
      idleTimeoutMs,
    });

    const downstream = await Promise.resolve(
      wrapper(
        { provider: "opencode-go", id: "glm-4.6" } as ProviderModel,
        {} as ProviderContext,
        {} as ProviderCallOptions,
      ),
    );
    expect(downstream).toBeDefined();
    if (!downstream) {
      return;
    }

    const received: AnyEvent[] = [];
    const consumer = (async () => {
      for await (const event of downstream) {
        received.push(event);
      }
    })();

    const partial = { role: "assistant", content: [{ type: "text", text: "x" }] };

    // Provider starts producing a tool-call turn. The last *delta* arms the idle timer.
    controller.emit({ type: "start", partial } as AnyEvent);
    controller.emit({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "{",
      partial,
    } as AnyEvent);
    await vi.advanceTimersByTimeAsync(0);

    // The model finalizes the tool call and deliberates on the next one,
    // emitting real block-boundary events that prove the SSE socket is alive.
    // Each gap is < idleTimeoutMs, so a liveness-aware watchdog must stay armed.
    await vi.advanceTimersByTimeAsync(3_000);
    controller.emit(
      asProviderEvent({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { name: "f", arguments: "{}" },
        partial,
      }),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    controller.emit({
      type: "toolcall_start",
      contentIndex: 1,
      partial,
    } as AnyEvent);

    // Advance to 5s after the last delta, but only 2s after the last
    // boundary event. The idle timer should have been re-armed by the
    // boundary events, so it must NOT fire yet.
    await vi.advanceTimersByTimeAsync(1_000);

    // The provider's completed answer arrives right after.
    controller.emit({
      type: "done",
      reason: "stop",
      message: {
        ...partial,
        content: [{ type: "text", text: "final answer" }],
        stopReason: "stop",
      },
    } as AnyEvent);
    controller.end();
    await vi.advanceTimersByTimeAsync(0);
    await consumer;

    const hasDone = received.some((e) => e.type === "done");
    const hasStalledError = received.some(
      (e) => e.type === "error" && e.error?.stopReason === "error",
    );

    expect(abortCalled).toBe(false);
    expect(hasDone).toBe(true);
    expect(hasStalledError).toBe(false);
  });
});
