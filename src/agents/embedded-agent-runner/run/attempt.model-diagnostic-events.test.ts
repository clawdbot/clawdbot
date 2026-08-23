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

  it("captures output and completes when callers only await stream.result()", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "compaction summary" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18 },
      stopReason: "stop",
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
    expect(events.map(({ event }) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const completedEvent = getEvent(
      events.map((entry) => entry.event),
      1,
    );
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-result-only");
    expect(completedEvent.responseStreamBytes).toBe(
      Buffer.byteLength(JSON.stringify(assistant), "utf8"),
    );
    expect(events[1]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[1]?.privateData.modelContent?.systemPrompt).toBe("summarize accurately");
    expect(events[1]?.privateData.modelContent?.outputMessages).toEqual([assistant]);
  });

  it("closes the underlying iterator when result() completes before the consumer abandons it", async () => {
    // Mirrors packages/agent-core/src/agent-loop.ts: iterate, await result() on
    // the terminal event, then return (abandoning the iterator). The iterator's
    // return() carries provider cleanup (idle-timeout abort listeners, readers),
    // so it must still run even though result() emits the terminal event first.
    let returnCalled = false;
    const doneEvent = { type: "done", message: { role: "assistant", content: "ok" } };
    const stream = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              return { value: doneEvent, done: false };
            }
            return { value: undefined, done: true };
          },
          async return() {
            returnCalled = true;
            return { value: undefined, done: true };
          },
        };
      },
      result: async () => doneEvent.message,
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
      for await (const event of response as AsyncIterable<{ type: string }>) {
        if (event.type === "done") {
          await (response as { result: () => Promise<unknown> }).result();
          break;
        }
      }
    });

    expect(returnCalled).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
  });

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
});
