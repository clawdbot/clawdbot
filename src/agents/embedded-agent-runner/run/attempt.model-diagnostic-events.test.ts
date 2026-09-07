// Coverage for model-call diagnostic events around attempt stream functions.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPrivateData,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { resolveCoreModelRequestLifecycleDiagnosticMetadata } from "../../../infra/diagnostic-model-request.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../../../infra/net/undici-global-dispatcher.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

async function collectModelCallEvents(
  run: () => Promise<void>,
  onEvent?: (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void,
): Promise<DiagnosticEventPayload[]> {
  // Diagnostics are emitted asynchronously; collect only public model-call
  // events and flush one tick after the stream completes.
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    onEvent?.(event, metadata);
    if (event.type.startsWith("model.call.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return events;
  } finally {
    stop();
  }
}

async function collectTrustedModelCallEvents(run: () => Promise<void>): Promise<
  Array<{
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  }>
> {
  const events: Array<{
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if (event.type.startsWith("model.call.")) {
      events.push({ event, privateData });
    }
  });
  try {
    await run();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return events;
  } finally {
    stop();
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  // Force stream iteration so completion events include response byte and timing
  // accounting.
  for await (const _ of stream) {
    // drain
  }
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function expectNumberField(record: Record<string, unknown>, key: string) {
  expect(typeof record[key]).toBe("number");
}

function getEvent(events: readonly DiagnosticEventPayload[], index: number) {
  return requireRecord(events[index], `event ${index}`);
}

describe("wrapStreamFnWithDiagnosticModelCallEvents stream proxy", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
    startDiagnosticRunActivityTracking();
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits started and completed events for async streams", async () => {
    // Request payloads are measured for diagnostics but must be redacted from
    // public event bodies.
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const originalStream = stream() as unknown as AsyncIterable<unknown> & {
      result: () => Promise<string>;
    };
    originalStream.result = async () => "kept";
    const requestPayload = {
      input: [{ role: "user", content: "secret prompt sk-test-secret-value" }],
      model: "gpt-5.4",
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        options?.onPayload?.(requestPayload, model);
        return originalStream;
      }) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
        }),
        nextCallId: () => "call-1",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const returned = wrapped(
        { requestTimeoutMs: 300_000 } as never,
        {} as never,
        {} as never,
      ) as unknown as typeof originalStream;
      expect(returned).not.toBe(originalStream);
      expect(await returned.result()).toBe("kept");
      await drain(returned);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const startedEvent = getEvent(events, 0);
    expect(startedEvent.type).toBe("model.call.started");
    expect(startedEvent.runId).toBe("run-1");
    expect(startedEvent.callId).toBe("call-1");
    expect(startedEvent.sessionKey).toBe("session-key");
    expect(startedEvent.sessionId).toBe("session-id");
    expect(startedEvent.provider).toBe("openai");
    expect(startedEvent.model).toBe("gpt-5.4");
    expect(startedEvent.api).toBe("openai-responses");
    expect(startedEvent.transport).toBe("http");
    expect(startedEvent.observationUnit).toBe("request");
    expect(events[0]?.trace?.parentSpanId).toBe("00f067aa0ba902b7");
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-1");
    expectNumberField(completedEvent, "durationMs");
    expect(completedEvent.requestPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify(requestPayload), "utf8"),
    );
    expectNumberField(completedEvent, "responseStreamBytes");
    expectNumberField(completedEvent, "timeToFirstByteMs");
    expect(JSON.stringify(events)).not.toContain("sk-test-secret-value");
  });

  it("normalizes the timeout from each exact model request", async () => {
    let callSequence = 0;
    const requestTimeouts: Array<number | undefined> = [];
    const ownerGeneration = Object.freeze({});
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() =>
        (async function* () {
          yield { type: "text", text: "ok" };
        })()) as unknown as StreamFn,
      {
        runId: "run-timeouts",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => `call-${++callSequence}`,
        ownerGeneration,
      },
    );

    await collectModelCallEvents(
      async () => {
        await drain(await wrapped({ requestTimeoutMs: 60_000 } as never, {} as never, {} as never));
        await drain(await wrapped({} as never, {} as never, {} as never));
        await drain(await wrapped({ requestTimeoutMs: 90_000 } as never, {} as never, {} as never));
        await drain(
          await wrapped(
            { requestTimeoutMs: Number.MAX_SAFE_INTEGER } as never,
            {} as never,
            {} as never,
          ),
        );
        await drain(await wrapped({ requestTimeoutMs: -1 } as never, {} as never, {} as never));
      },
      (event, metadata) => {
        if (event.type === "model.call.started") {
          const lifecycle = resolveCoreModelRequestLifecycleDiagnosticMetadata(metadata);
          requestTimeouts.push(
            lifecycle?.phase === "started" ? lifecycle.requestTimeoutMs : undefined,
          );
        }
      },
    );

    expect(requestTimeouts).toEqual([60_000, undefined, 90_000, MAX_TIMER_TIMEOUT_MS, undefined]);
  });

  it("propagates the resolved local transport deadline to diagnostic recovery", async () => {
    let callSequence = 0;
    const requestTimeouts: Array<number | undefined> = [];
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() =>
        (async function* () {
          yield { type: "text", text: "ok" };
        })()) as unknown as StreamFn,
      {
        runId: "run-local-no-gap",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "ollama",
        model: "qwen3.5:9b-q8_0",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => `call-${++callSequence}`,
        ownerGeneration: Object.freeze({}),
        requestTimeoutMs: DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
      },
    );

    await collectModelCallEvents(
      async () => {
        await drain(await wrapped({} as never, {} as never, {} as never));
      },
      (event, metadata) => {
        if (event.type === "model.call.started") {
          const lifecycle = resolveCoreModelRequestLifecycleDiagnosticMetadata(metadata);
          requestTimeouts.push(
            lifecycle?.phase === "started" ? lifecycle.requestTimeoutMs : undefined,
          );
        }
      },
    );

    expect(requestTimeouts).toEqual([DEFAULT_UNDICI_STREAM_TIMEOUT_MS]);
  });

  it("preserves an explicit provider deadline over the caller transport allowance", async () => {
    let callSequence = 0;
    const requestTimeouts: Array<number | undefined> = [];
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() =>
        (async function* () {
          yield { type: "text", text: "ok" };
        })()) as unknown as StreamFn,
      {
        runId: "run-resolved-policy",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => `call-${++callSequence}`,
        ownerGeneration: Object.freeze({}),
        requestTimeoutMs: 45_000,
      },
    );

    await collectModelCallEvents(
      async () => {
        await drain(
          await wrapped({ requestTimeoutMs: 300_000 } as never, {} as never, {} as never),
        );
      },
      (event, metadata) => {
        if (event.type === "model.call.started") {
          const lifecycle = resolveCoreModelRequestLifecycleDiagnosticMetadata(metadata);
          requestTimeouts.push(
            lifecycle?.phase === "started" ? lifecycle.requestTimeoutMs : undefined,
          );
        }
      },
    );

    expect(requestTimeouts).toEqual([300_000]);
  });

  it.each([
    { stopReason: "stop", terminalType: "model.call.completed" },
    { stopReason: "error", terminalType: "model.call.error" },
    { stopReason: "aborted", terminalType: "model.call.error" },
  ])(
    "records $stopReason when callers only await stream.result()",
    async ({ stopReason, terminalType }) => {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "compaction summary" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 },
        stopReason,
        errorMessage: stopReason === "stop" ? undefined : "synthetic provider failure",
        timestamp: 1,
      };
      const originalStream = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              throw new Error("result-only callers should not need stream iteration");
            },
          };
        },
        result: vi.fn(async () => assistant),
      };
      const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
        (() => originalStream) as unknown as StreamFn,
        {
          runId: "run-compact",
          sessionKey: "session-key",
          sessionId: "session-id",
          provider: "openai",
          model: "gpt-5.4",
          trace: createDiagnosticTraceContext(),
          contentCapture: {
            inputMessages: true,
            outputMessages: true,
            toolInputs: false,
            toolOutputs: false,
            systemPrompt: true,
            toolDefinitions: true,
            anyModelContent: true,
          },
          nextCallId: () => "call-result-only",
        },
      );

      const inputMessages = [{ role: "user", content: "summarize this transcript", timestamp: 1 }];
      const events = await collectTrustedModelCallEvents(async () => {
        const streamResult = wrapped(
          {} as never,
          {
            systemPrompt: "summarize accurately",
            messages: inputMessages,
          } as never,
          {},
        ) as unknown as typeof originalStream;
        expect(await streamResult.result()).toBe(assistant);
      });

      expect(originalStream.result).toHaveBeenCalledOnce();
      expect(events.map(({ event }) => event.type)).toEqual(["model.call.started", terminalType]);
      const terminalEvent = getEvent(
        events.map((entry) => entry.event),
        1,
      );
      expect(terminalEvent.callId).toBe("call-result-only");
      expect(terminalEvent.responseStreamBytes).toBe(
        Buffer.byteLength(JSON.stringify(assistant), "utf8"),
      );
      expect(events[1]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
      expect(events[1]?.privateData.modelContent?.systemPrompt).toBe("summarize accurately");
      expect(events[1]?.privateData.modelContent?.outputMessages).toEqual([assistant]);
    },
  );

  it.each([
    { stopReason: "stop", resultFirst: false, terminalType: "model.call.completed" },
    { stopReason: "error", resultFirst: false, terminalType: "model.call.error" },
    { stopReason: "error", resultFirst: true, terminalType: "model.call.error" },
  ])(
    "closes the $stopReason iterator with resultFirst=$resultFirst",
    async ({ stopReason, resultFirst, terminalType }) => {
      // Mirrors packages/agent-core/src/agent-loop.ts: iterate, await result() on
      // the terminal event, then return (abandoning the iterator). The iterator's
      // return() carries provider cleanup (idle-timeout abort listeners, readers),
      // so it must still run regardless of which observer emits the terminal event.
      let returnCalled = false;
      const assistant = { role: "assistant", content: "ok", stopReason };
      const terminalEvent =
        stopReason === "stop"
          ? { type: "done", reason: stopReason, message: assistant }
          : { type: "error", reason: stopReason, error: assistant };
      const stream = {
        [Symbol.asyncIterator]() {
          let emitted = false;
          return {
            async next() {
              if (!emitted) {
                emitted = true;
                return { value: terminalEvent, done: false };
              }
              return { value: undefined, done: true };
            },
            async return() {
              returnCalled = true;
              return { value: undefined, done: true };
            },
          };
        },
        result: async () => assistant,
      };
      const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
        (() => stream) as unknown as StreamFn,
        {
          runId: "run-cleanup",
          provider: "openai",
          model: "gpt-5.4",
          trace: createDiagnosticTraceContext(),
          nextCallId: () => "call-cleanup",
        },
      );

      const events = await collectModelCallEvents(async () => {
        const response = wrapped({} as never, {} as never, {} as never) as unknown as typeof stream;
        const earlyResult = resultFirst ? await response.result() : undefined;
        for await (const event of response as AsyncIterable<{ type: string }>) {
          expect(event).toBe(terminalEvent);
          const result = resultFirst ? earlyResult : await response.result();
          expect(result).toBe(assistant);
          break;
        }
      });

      expect(returnCalled).toBe(true);
      expect(events.map((event) => event.type)).toEqual(["model.call.started", terminalType]);
    },
  );

  it("emits error events when stream iteration fails", async () => {
    const requestId = "req_provider_123";
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            throw new TypeError(`provider failed [request_id=${requestId}]`);
          },
        };
      },
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "anthropic",
        model: "sonnet-4.6",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-err",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await expect(
        drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>),
      ).rejects.toThrow("provider failed");
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.callId).toBe("call-err");
    expect(errorEvent.errorCategory).toBe("TypeError");
    expect(typeof errorEvent.upstreamRequestIdHash).toBe("string");
    expect(errorEvent.upstreamRequestIdHash).toMatch(/^sha256:[a-f0-9]{12}$/);
    expectNumberField(errorEvent, "durationMs");
    expect(JSON.stringify(events[1])).not.toContain(requestId);
  });

  it("does not mutate non-configurable provider streams", async () => {
    const stream = {};
    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: false,
      async *value() {
        yield { type: "text", text: "ok" };
      },
    });
    Object.freeze(stream);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-frozen",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const returned = wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as AsyncIterable<unknown>;
      expect(returned).not.toBe(stream);
      await drain(returned);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

  it("emits completed events when stream consumption stops early", async () => {
    async function* stream() {
      yield { type: "text", text: "first" };
      yield { type: "text", text: "second" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-abandoned",
      },
    );

    const events = await collectModelCallEvents(async () => {
      for await (const _ of wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as AsyncIterable<unknown>) {
        break;
      }
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-abandoned");
    expectNumberField(completedEvent, "durationMs");
    expect(events[1]).not.toHaveProperty("errorCategory");
  });

  it.each([
    {
      name: "rejected result after bare EOF",
      result: vi.fn(async () => {
        throw new Error("connection reset");
      }),
      terminalType: "model.call.error",
    },
    {
      name: "error stopReason result after bare EOF",
      result: vi.fn(async () => ({
        role: "assistant",
        content: "partial",
        stopReason: "error",
        errorMessage: "connection reset",
      })),
      terminalType: "model.call.error",
    },
    {
      name: "successful result after bare EOF",
      result: vi.fn(async () => ({
        role: "assistant",
        content: "ok",
        stopReason: "stop",
      })),
      terminalType: "model.call.completed",
    },
  ])("defers the terminal to result() after bare EOF: $name", async ({ result, terminalType }) => {
    // A bare-EOF stream ends its iterator without a terminal done/error chunk.
    // The stream contract lets result() carry the authoritative terminal: a
    // rejected result() or an error stopReason must publish model.call.error
    // instead of an early model.call.completed that dedupes the real failure.
    const stream = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              return { value: { type: "start" }, done: false };
            }
            return { value: undefined, done: true };
          },
          async return() {
            return { value: undefined, done: true };
          },
        };
      },
      result,
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-bare-eof",
        provider: "anthropic",
        model: "sonnet-4.6",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-bare-eof",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const wrappedStream = wrapped({} as never, {} as never, {} as never) as unknown as {
        [Symbol.asyncIterator](): AsyncIterator<unknown>;
        result(): Promise<unknown>;
      };
      for await (const _ of wrappedStream) {
        // drain to bare EOF
      }
      // result() may resolve (success or error stopReason) or reject; either
      // way it is the authoritative terminal after a bare-EOF iterator.
      await wrappedStream.result().catch(() => undefined);
    });

    expect(result).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(["model.call.started", terminalType]);
  });

  it("completes iterator-only bare EOF streams without a result() method", async () => {
    // An iterator-only stream has no result(): bare EOF has no later terminal
    // signal, so the diagnostic must still emit exactly one terminal (completed).
    async function* stream() {
      yield { type: "start" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-iterator-only",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-iterator-only",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

  it("emits error from a streamed terminal error chunk even when result() is exposed", async () => {
    // A streamed {type:"error"} chunk sets terminalError during iteration. When
    // the stream also exposes result(), the iterator's natural done must still
    // publish model.call.error immediately (terminalError is authoritative) and
    // exactly once — a later result() must not add a second terminal.
    const assistant = {
      role: "assistant",
      content: "partial",
      stopReason: "aborted",
      errorMessage: "caller aborted",
    };
    let resultCalls = 0;
    const stream = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              return { value: { type: "error", reason: "aborted", error: assistant }, done: false };
            }
            return { value: undefined, done: true };
          },
          async return() {
            return { value: undefined, done: true };
          },
        };
      },
      result: vi.fn(async () => {
        resultCalls += 1;
        return assistant;
      }),
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-streamed-error",
        provider: "anthropic",
        model: "sonnet-4.6",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-streamed-error",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const wrappedStream = wrapped({} as never, {} as never, {} as never) as unknown as {
        [Symbol.asyncIterator](): AsyncIterator<unknown>;
        result(): Promise<unknown>;
      };
      for await (const _ of wrappedStream) {
        // drain past the streamed error chunk to natural done
      }
      await wrappedStream.result().catch(() => undefined);
    });

    expect(resultCalls).toBe(1);
    // Exactly one terminal, and it is error — not completed, not duplicated.
    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
  });

  it.each([
    {
      name: "rejected result",
      result: vi.fn(async () => {
        throw new Error("connection reset");
      }),
      terminalType: "model.call.error",
    },
    {
      name: "successful result",
      result: vi.fn(async () => ({
        role: "assistant",
        content: "ok",
        stopReason: "stop",
      })),
      terminalType: "model.call.completed",
    },
  ])(
    "observes the deferred result for consumers that never call result(): $name",
    async ({ result, terminalType }) => {
      // Mirrors src/gateway/worker-environments/inference-runtime.ts: it drains
      // the stream but returns without calling events.result(). A bare-EOF
      // stream exposes result(), so the wrapper must observe it itself to avoid
      // leaving only model.call.started with no terminal timeline or hook event.
      let resultCalls = 0;
      const originalResult = result;
      const instrumentedResult = vi.fn(async () => {
        resultCalls += 1;
        return originalResult();
      });
      const stream = {
        [Symbol.asyncIterator]() {
          let emitted = false;
          return {
            async next() {
              if (!emitted) {
                emitted = true;
                return { value: { type: "start" }, done: false };
              }
              return { value: undefined, done: true };
            },
            async return() {
              return { value: undefined, done: true };
            },
          };
        },
        result: instrumentedResult,
      };
      const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
        (() => stream) as unknown as StreamFn,
        {
          runId: "run-worker-eof",
          provider: "anthropic",
          model: "sonnet-4.6",
          trace: createDiagnosticTraceContext(),
          nextCallId: () => "call-worker-eof",
        },
      );

      const events = await collectModelCallEvents(async () => {
        // Consumer drains to bare EOF and returns WITHOUT calling result().
        await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
      });

      // The wrapper observed result() itself exactly once, and emitted exactly
      // one terminal event driven by that result.
      expect(resultCalls).toBe(1);
      expect(events.map((event) => event.type)).toEqual(["model.call.started", terminalType]);
    },
  );
});
