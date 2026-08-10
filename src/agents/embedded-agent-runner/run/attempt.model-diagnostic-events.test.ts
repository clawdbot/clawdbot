import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bindCachedInputObservation } from "@openclaw/ai/internal/shared";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
// Coverage for model-call diagnostic events around attempt stream functions.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
  waitForDiagnosticEventsDrained,
} from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { registerDiagnosticTracePropagationBridge } from "../../../infra/diagnostic-trace-propagation.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  createProviderTransportAccountingCollector,
  observeProviderTransportEvent,
  runWithProviderTransportAccountingObserver,
} from "../../provider-transport-accounting.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function collectModelCallEvents(run: () => Promise<void>): Promise<DiagnosticEventPayload[]> {
  // Diagnostics are emitted asynchronously; collect only public model-call
  // events and flush one tick after the stream completes.
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function expectNumberField(record: Record<string, unknown>, key: string) {
  expect(typeof record[key]).toBe("number");
}

function getEvent(events: readonly DiagnosticEventPayload[], index: number) {
  return requireRecord(events[index], `event ${index}`);
}

function requireMockRecordArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
  label: string,
) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], label);
}

async function collectProviderTimelineEvents(run: () => Promise<void>) {
  const root = tempDirs.make("openclaw-provider-timeline-");
  const timelinePath = join(root, "timeline.jsonl");
  await withEnvAsync(
    {
      OPENCLAW_DIAGNOSTICS: "1",
      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
    },
    run,
  );
  return readFileSync(timelinePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => requireRecord(JSON.parse(line), "provider timeline event"))
    .filter((event) => event.type === "provider.request");
}

function observeAttempt(params: {
  callId: string;
  provider: string;
  model: string;
  api: string;
  transport: string;
  outcome: "completed" | "failed" | "aborted";
  eventId?: string;
}): void {
  observeProviderTransportEvent({
    type: "attempt",
    eventId: params.eventId ?? `attempt-${params.callId}-${params.outcome}`,
    callId: params.callId,
    provider: params.provider,
    model: params.model,
    api: params.api,
    transport: params.transport,
    ordinal: 1,
    reason: "initial",
    outcome: params.outcome,
  });
}

function completedAssistantMessage(content: unknown = []) {
  return { role: "assistant", content, stopReason: "stop" as const };
}

function completedTerminalEvent(content: unknown = []) {
  return {
    type: "done" as const,
    reason: "stop" as const,
    message: completedAssistantMessage(content),
  };
}

describe("wrapStreamFnWithDiagnosticModelCallEvents", () => {
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

  it("joins logical-call accounting to the propagated request correlation id", async () => {
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        _model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        const callId = options?.requestId;
        if (!callId) {
          throw new Error("missing propagated request id");
        }
        observeAttempt({
          callId,
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          outcome: "completed",
        });
        return (async function* () {
          yield {
            type: "done",
            reason: "stop",
            message: { role: "assistant", content: [], stopReason: "stop" },
          };
        })();
      }) as unknown as StreamFn,
      {
        runId: "run-accounting",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-accounting",
      },
    );

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(await wrapped({} as never, {} as never, {}));
    });

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 1,
          entries: [
            {
              callId: "call-accounting",
              provider: "openai",
              model: "gpt-test",
              api: "openai-responses",
              transport: "http",
              outcome: "completed",
            },
          ],
        },
        attempts: { total: 1 },
      },
    });
  });

  it("emits started and completed events for async streams", async () => {
    // Request payloads are measured for diagnostics but must be redacted from
    // public event bodies.
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const terminalResult = completedAssistantMessage("kept");
    const originalStream = stream() as unknown as AsyncIterable<unknown> & {
      result: () => Promise<typeof terminalResult>;
    };
    originalStream.result = async () => terminalResult;
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
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as typeof originalStream;
      expect(returned).not.toBe(originalStream);
      expect(await returned.result()).toBe(terminalResult);
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

  it("emits one successful provider timeline event for result and iterator completion", async () => {
    let now = Date.parse("2026-07-09T18:30:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const terminalResult = completedAssistantMessage("kept");
    const originalStream = stream() as unknown as AsyncIterable<unknown> & {
      result: () => Promise<typeof terminalResult>;
    };
    originalStream.result = async () => {
      now += 125;
      return terminalResult;
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => originalStream) as unknown as StreamFn,
      {
        runId: "run-timeline-success",
        provider: "openai",
        model: "gpt-5.5",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-timeline-success",
      },
    );

    const events = await collectProviderTimelineEvents(async () => {
      const returned = wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as typeof originalStream;
      await returned.result();
      await drain(returned);
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "provider.request",
      name: "provider.request",
      timestamp: "2026-07-09T18:30:00.000Z",
      runId: "run-timeline-success",
      spanId: "call-timeline-success",
      durationMs: 125,
      provider: "openai",
      operation: "openai-responses",
      ok: true,
      attributes: {
        model: "gpt-5.5",
        api: "openai-responses",
        transport: "http",
      },
    });
    expect(events[0]?.status).toBeUndefined();
  });

  it("records provider response status and preserves the original response callback", async () => {
    const originalOnResponse = vi.fn(async () => undefined);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        const response = options?.onResponse?.(
          { status: 200, headers: { "x-request-id": "req-1" } },
          model,
        );
        return Promise.resolve(response).then(() => completedAssistantMessage());
      }) as unknown as StreamFn,
      {
        runId: "run-timeline-status",
        provider: "openai",
        model: "gpt-5.6",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-timeline-status",
      },
    );

    const events = await collectProviderTimelineEvents(async () => {
      await wrapped(
        { id: "gpt-5.6" } as never,
        {} as never,
        {
          onResponse: originalOnResponse,
        } as never,
      );
    });

    expect(originalOnResponse).toHaveBeenCalledWith(
      { status: 200, headers: { "x-request-id": "req-1" } },
      { id: "gpt-5.6" },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "provider.request",
      ok: true,
      status: 200,
    });
  });

  it("writes Unicode-safe bounded attributes to the provider timeline JSONL", async () => {
    const modelPrefix = "m".repeat(255);
    const exactBoundary = "b".repeat(256);
    const events = await collectProviderTimelineEvents(async () => {
      const cases: Array<{ callId: string; model: string }> = [
        { callId: "call-timeline-unicode-boundary", model: `${modelPrefix}😀tail` },
        { callId: "call-timeline-exact-boundary", model: exactBoundary },
      ];
      for (const { callId, model } of cases) {
        const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
          (() => completedAssistantMessage()) as unknown as StreamFn,
          {
            runId: "run-timeline-unicode-boundary",
            provider: "openai",
            model,
            trace: createDiagnosticTraceContext(),
            nextCallId: () => callId,
          },
        );
        await wrapped({} as never, {} as never, {} as never);
      }
    });

    expect(events).toHaveLength(2);
    const splitBoundaryModel = readRecordField(events[0]!, "attributes", "attributes").model;
    expect(splitBoundaryModel).toBe(modelPrefix);
    expect(splitBoundaryModel).toHaveLength(255);
    expect(splitBoundaryModel).not.toContain("�");
    expect(splitBoundaryModel).not.toMatch(/[\uD800-\uDFFF]/u);
    const exactBoundaryModel = readRecordField(events[1]!, "attributes", "attributes").model;
    expect(exactBoundaryModel).toBe(exactBoundary);
    expect(exactBoundaryModel).toHaveLength(256);
  });

  it("emits one failed provider timeline event for a thrown model call", async () => {
    let now = Date.parse("2026-07-09T18:31:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        now += 75;
        throw new Error("provider failed");
      }) as unknown as StreamFn,
      {
        runId: "run-timeline-error",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        transport: "sse",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-timeline-error",
      },
    );

    const events = await collectProviderTimelineEvents(async () => {
      expect(() => wrapped({} as never, {} as never, {} as never)).toThrow("provider failed");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "provider.request",
      name: "provider.request",
      timestamp: "2026-07-09T18:31:00.000Z",
      runId: "run-timeline-error",
      spanId: "call-timeline-error",
      durationMs: 75,
      provider: "anthropic",
      operation: "sse",
      ok: false,
      attributes: {
        model: "claude-sonnet-4-6",
        transport: "sse",
      },
    });
  });

  it("records a non-2xx provider response on a failed model call", async () => {
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }) as unknown as StreamFn,
      {
        runId: "run-timeline-http-error",
        provider: "openai",
        model: "gpt-5.6",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-timeline-http-error",
      },
    );

    const events = await collectProviderTimelineEvents(async () => {
      expect(() => wrapped({} as never, {} as never, {} as never)).toThrow("rate limited");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "provider.request",
      ok: false,
      status: 429,
    });
  });

  it("keeps an observed response status when the terminal error has another status", async () => {
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        void options?.onResponse?.({ status: 503, headers: {} }, model);
        throw Object.assign(new Error("retry failed"), { status: 429 });
      }) as unknown as StreamFn,
      {
        runId: "run-timeline-observed-http-error",
        provider: "openai",
        model: "gpt-5.6",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-timeline-observed-http-error",
      },
    );

    const events = await collectProviderTimelineEvents(async () => {
      expect(() => wrapped({} as never, {} as never, {} as never)).toThrow("retry failed");
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "provider.request",
      ok: false,
      status: 503,
    });
  });

  it("updates diagnostic run activity from throttled stream chunks", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    async function* stream() {
      yield { type: "text_delta", delta: "first" };
      yield { type: "text_delta", delta: "second" };
      yield { type: "text_delta", delta: "third" };
    }
    const runProgressEvents: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        runProgressEvents.push(event);
      }
    });
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "vllm",
        model: "qwen/qwen3.5-9b",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-stream",
      },
    );

    const returned = wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>;
    const iterator = returned[Symbol.asyncIterator]();

    try {
      await iterator.next();
      await waitForDiagnosticEventsDrained();
      let snapshot = getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      });
      expect(snapshot.activeWorkKind).toBe("model_call");
      expect(snapshot.lastProgressReason).toBe("model_call:stream_progress");
      expect(snapshot.lastProgressAgeMs).toBe(0);
      expect(runProgressEvents).toHaveLength(1);

      now += 10_000;
      await iterator.next();
      await waitForDiagnosticEventsDrained();
      snapshot = getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      });
      expect(snapshot.lastProgressReason).toBe("model_call:stream_progress");
      expect(snapshot.lastProgressAgeMs).toBe(0);
      expect(runProgressEvents).toHaveLength(1);

      now += 30_000;
      await iterator.next();
      await waitForDiagnosticEventsDrained();
      snapshot = getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      });
      expect(snapshot.lastProgressReason).toBe("model_call:stream_progress");
      expect(snapshot.lastProgressAgeMs).toBe(0);
      expect(runProgressEvents).toHaveLength(2);
    } finally {
      await iterator.return?.();
      await waitForDiagnosticEventsDrained();
      stop();
    }
  });

  it("does not retain stream progress activity when diagnostics are disabled", async () => {
    setDiagnosticsEnabledForProcess(false);
    const runProgressEvents: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        runProgressEvents.push(event);
      }
    });
    async function* stream() {
      yield { type: "text_delta", delta: "first" };
      yield { type: "text_delta", delta: "second" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "vllm",
        model: "qwen/qwen3.5-9b",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-disabled-diagnostics",
      },
    );

    try {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
      await waitForDiagnosticEventsDrained();
    } finally {
      stop();
    }

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionKey: "session-key",
        sessionId: "session-id",
      }),
    ).toEqual({});
    expect(runProgressEvents).toEqual([]);
  });

  it("counts async onPayload replacements instead of raw payload content", async () => {
    async function* stream() {
      yield { type: "text_delta", delta: "safe" };
      yield completedTerminalEvent();
    }
    const originalPayload = { input: "secret sk-original-secret" };
    const replacementPayload = { input: "redacted" };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (async (
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        await options?.onPayload?.(originalPayload, model);
        return stream();
      }) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-payload",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const streamResult = await wrapped({} as never, {} as never, {
        onPayload: async () => replacementPayload,
      });
      await drain(streamResult as unknown as AsyncIterable<unknown>);
    });

    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.callId).toBe("call-payload");
    expect(completedEvent.requestPayloadBytes).toBe(
      Buffer.byteLength(JSON.stringify(replacementPayload), "utf8"),
    );
    expectNumberField(completedEvent, "responseStreamBytes");
    expectNumberField(completedEvent, "timeToFirstByteMs");
    expect(JSON.stringify(events)).not.toContain("sk-original-secret");
  });

  it("counts text deltas without serializing full partial snapshots", async () => {
    const serializedPartial = vi.fn(() => {
      throw new Error("partial snapshot should not be serialized for text deltas");
    });
    const terminalEvent = completedTerminalEvent();
    async function* stream() {
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "a",
        partial: {
          toJSON: serializedPartial,
          role: "assistant",
          content: [{ type: "text", text: "a".repeat(200_000) }],
        },
      };
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "bc",
        partial: {
          toJSON: serializedPartial,
          role: "assistant",
          content: [{ type: "text", text: "abc".repeat(200_000) }],
        },
      };
      yield terminalEvent;
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-delta-bytes",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });

    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.responseStreamBytes).toBe(
      Buffer.byteLength("abc", "utf8") + Buffer.byteLength(JSON.stringify(terminalEvent), "utf8"),
    );
    expect(serializedPartial).not.toHaveBeenCalled();
  });

  it("keeps streams alive when diagnostic byte inspection cannot read a chunk", async () => {
    const opaqueChunk = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return undefined;
          }
          throw new Error("chunk should not be inspected");
        },
      },
    );
    const terminalEvent = completedTerminalEvent();
    async function* stream() {
      yield opaqueChunk;
      yield { type: "text_delta", delta: "ok" };
      yield terminalEvent;
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-opaque-chunk",
      },
    );

    const chunks: unknown[] = [];
    const events = await collectModelCallEvents(async () => {
      for await (const chunk of wrapped(
        {} as never,
        {} as never,
        {} as never,
      ) as AsyncIterable<unknown>) {
        chunks.push(chunk);
      }
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toBe(opaqueChunk);
    expect(chunks[1]).toEqual({ type: "text_delta", delta: "ok" });
    expect(chunks[2]).toEqual(terminalEvent);
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.responseStreamBytes).toBe(
      Buffer.byteLength("ok", "utf8") + Buffer.byteLength(JSON.stringify(terminalEvent), "utf8"),
    );
  });

  it("captures model input, tools, and output only when content capture is enabled", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "trace reply" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: 1,
    };
    async function* stream() {
      yield { type: "done", reason: "stop", message: assistant };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
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
        nextCallId: () => "call-content",
      },
    );

    const inputMessages = [{ role: "user", content: "trace prompt", timestamp: 1 }];
    const tools = [{ name: "lookup", description: "Lookup data", parameters: { type: "object" } }];
    const events = await collectTrustedModelCallEvents(async () => {
      const streamResult = wrapped(
        {} as never,
        {
          systemPrompt: "trace system",
          messages: inputMessages,
          tools,
        } as never,
        {},
      );
      await drain(streamResult as unknown as AsyncIterable<unknown>);
    });

    const startedEvent = getEvent(
      events.map((entry) => entry.event),
      0,
    );
    expect(startedEvent.type).toBe("model.call.started");
    expect(startedEvent.inputMessages).toBeUndefined();
    expect(startedEvent.systemPrompt).toBeUndefined();
    expect(startedEvent.toolDefinitions).toBeUndefined();
    expect(events[0]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[0]?.privateData.modelContent?.systemPrompt).toBe("trace system");
    expect(events[0]?.privateData.modelContent?.toolDefinitions).toEqual(tools);
    const completedEvent = getEvent(
      events.map((entry) => entry.event),
      1,
    );
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.outputMessages).toBeUndefined();
    expect(events[1]?.privateData.modelContent?.inputMessages).toEqual(inputMessages);
    expect(events[1]?.privateData.modelContent?.outputMessages).toEqual([assistant]);
  });

  it("emits safe prompt stats and per-call usage without content capture", async () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "trace reply" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        reasoningTokens: 5,
        totalTokens: 28,
      },
      stopReason: "stop",
      timestamp: 1,
    };
    async function* stream() {
      yield { type: "done", reason: "stop", message: assistant };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-stats",
      },
    );

    const inputMessages = [{ role: "user", content: "private prompt text", timestamp: 1 }];
    const tools = [
      { name: "lookup", description: "private tool description", parameters: { type: "object" } },
    ];
    const systemPrompt = "private system prompt";
    const events = await collectModelCallEvents(async () => {
      const streamResult = wrapped(
        {} as never,
        {
          systemPrompt,
          messages: inputMessages,
          tools,
        } as never,
        {},
      );
      await drain(streamResult as unknown as AsyncIterable<unknown>);
    });

    const startedEvent = getEvent(events, 0);
    const completedEvent = getEvent(events, 1);
    const expectedPromptStats = {
      inputMessagesCount: inputMessages.length,
      inputMessagesChars: JSON.stringify(inputMessages).length,
      systemPromptChars: systemPrompt.length,
      toolDefinitionsCount: tools.length,
      toolDefinitionsChars: JSON.stringify(tools).length,
      totalChars:
        JSON.stringify(inputMessages).length + systemPrompt.length + JSON.stringify(tools).length,
    };
    expect(startedEvent.promptStats).toEqual(expectedPromptStats);
    expect(completedEvent.promptStats).toEqual(expectedPromptStats);
    expect(completedEvent.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      reasoningTokens: 5,
      total: 28,
      promptTokens: 16,
    });
    expect(JSON.stringify(events)).not.toContain("private prompt text");
    expect(JSON.stringify(events)).not.toContain("private system prompt");
    expect(JSON.stringify(events)).not.toContain("private tool description");
  });

  it("captures per-call usage from terminal error events", async () => {
    // Aborted/error streams terminate with an `error` event carrying the final
    // AssistantMessage and its usage. Iterating to completion without awaiting
    // result() must still surface per-call usage, matching the `done` path and
    // the usage field already emitted on model.call.error and its OTel span.
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial reply" }],
      usage: {
        input: 11,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        reasoningTokens: 5,
        totalTokens: 28,
      },
      stopReason: "aborted",
      timestamp: 1,
    };
    bindCachedInputObservation(assistant.usage as never, { state: "exact", tokens: 3 });
    async function* stream() {
      observeAttempt({
        callId: "call-error-usage",
        provider: "openrouter",
        model: "openrouter/auto",
        api: "openai-responses",
        transport: "http",
        outcome: "aborted",
      });
      yield { type: "error", reason: "aborted", error: assistant };
    }
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openrouter",
        model: "openrouter/auto",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-error-usage",
      },
    );

    const events = await collectModelCallEvents(async () =>
      runWithProviderTransportAccountingObserver(collector.observer, async () => {
        await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
      }),
    );

    // An in-band error event is data, not a throw, but it is still the
    // authoritative failed/aborted terminal outcome for accounting.
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.failureKind).toBe("aborted");
    expect(errorEvent.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      reasoningTokens: 5,
      total: 28,
      promptTokens: 16,
    });
    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 0,
          failed: 0,
          aborted: 1,
          entries: [
            {
              callId: "call-error-usage",
              outcome: "aborted",
              cachedInput: { state: "exact", tokens: 3 },
            },
          ],
        },
      },
    });
  });

  it("settles in-band provider errors as failed calls", async () => {
    const collector = createProviderTransportAccountingCollector();
    async function* stream() {
      observeAttempt({
        callId: "call-in-band-failed",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        outcome: "failed",
      });
      yield {
        type: "error",
        reason: "provider_error",
        error: { role: "assistant", content: [], stopReason: "error" },
      };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-in-band-failed",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-in-band-failed",
      },
    );

    const events = await collectModelCallEvents(async () =>
      runWithProviderTransportAccountingObserver(collector.observer, async () => {
        await drain(wrapped({} as never, {} as never, {}) as AsyncIterable<unknown>);
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ callId: "call-in-band-failed", outcome: "failed" }],
        },
      },
    });
  });

  it.each(["stop", "length", "toolUse"] as const)(
    "completes only a matching done/%s terminal",
    async (stopReason) => {
      async function* stream() {
        yield {
          type: "done",
          reason: stopReason,
          message: { role: "assistant", content: [], stopReason },
        };
      }
      const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
        (() => stream()) as unknown as StreamFn,
        {
          runId: `run-done-${stopReason}`,
          provider: "openai",
          model: "gpt-test",
          trace: createDiagnosticTraceContext(),
          nextCallId: () => `call-done-${stopReason}`,
        },
      );

      const events = await collectModelCallEvents(async () => {
        await drain(wrapped({} as never, {} as never, {}) as AsyncIterable<unknown>);
      });

      expect(events.map((event) => event.type)).toEqual([
        "model.call.started",
        "model.call.completed",
      ]);
    },
  );

  it.each([
    ["missing reason", { type: "done", message: completedAssistantMessage() }],
    ["missing message", { type: "done", reason: "stop" }],
    ["non-record message", { type: "done", reason: "stop", message: "invalid" }],
    ["missing nested reason", { type: "done", reason: "stop", message: { role: "assistant" } }],
    [
      "unknown reason",
      {
        type: "done",
        reason: "future-provider-stop",
        message: { role: "assistant", stopReason: "future-provider-stop" },
      },
    ],
    [
      "mismatched reason",
      {
        type: "done",
        reason: "stop",
        message: { role: "assistant", stopReason: "length" },
      },
    ],
  ] as const)("fails an incomplete done terminal with %s", async (_name, terminal) => {
    async function* stream() {
      yield terminal;
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-invalid-done",
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-invalid-done",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {}) as AsyncIterable<unknown>);
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    expect(getEvent(events, 1).errorCategory).toBe("Error");
  });

  it("classifies matching error and aborted envelopes without message heuristics", async () => {
    const cases = [
      {
        callId: "call-envelope-error",
        outcome: "failed" as const,
        terminal: {
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "neutral provider failure",
          },
        },
      },
      {
        callId: "call-envelope-aborted",
        outcome: "aborted" as const,
        terminal: {
          type: "error",
          reason: "aborted",
          error: {
            role: "assistant",
            content: [],
            stopReason: "aborted",
            errorMessage: "cancelled by operator",
          },
        },
      },
    ];

    for (const testCase of cases) {
      const collector = createProviderTransportAccountingCollector();
      async function* stream() {
        observeAttempt({
          callId: testCase.callId,
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          outcome: testCase.outcome,
        });
        yield testCase.terminal;
      }
      const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
        (() => stream()) as unknown as StreamFn,
        {
          runId: `run-${testCase.callId}`,
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          trace: createDiagnosticTraceContext(),
          nextCallId: () => testCase.callId,
        },
      );

      const events = await collectModelCallEvents(async () =>
        runWithProviderTransportAccountingObserver(collector.observer, async () => {
          await drain(wrapped({} as never, {} as never, {}) as AsyncIterable<unknown>);
        }),
      );

      const errorEvent = getEvent(events, 1);
      expect(errorEvent.type).toBe("model.call.error");
      if (testCase.outcome === "aborted") {
        expect(errorEvent.errorCategory).toBe("Error");
        expect(errorEvent.failureKind).toBe("aborted");
      } else {
        expect(errorEvent.errorCategory).toBe("Error");
      }
      expect(collector.project()).toMatchObject({
        coverage: { state: "complete" },
        snapshot: {
          logicalCalls: {
            [testCase.outcome]: 1,
            entries: [{ callId: testCase.callId, outcome: testCase.outcome }],
          },
        },
      });
    }
  });

  it.each([
    [
      "mismatched reason",
      {
        type: "error",
        reason: "error",
        error: { role: "assistant", stopReason: "aborted" },
      },
    ],
    ["missing error", { type: "error", reason: "error" }],
    ["non-record error", { type: "error", reason: "error", error: "invalid" }],
  ] as const)("fails an incomplete error terminal with %s", async (_name, terminal) => {
    async function* stream() {
      yield terminal;
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-invalid-error",
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-invalid-error",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {}) as AsyncIterable<unknown>);
    });

    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.errorCategory).toBe("Error");
    expect(errorEvent.failureKind).toBeUndefined();
  });

  it.each([
    ["stop", completedAssistantMessage()],
    ["length", { role: "assistant", content: [], stopReason: "length" }],
    ["toolUse", { role: "assistant", content: [], stopReason: "toolUse" }],
    ["error", { role: "assistant", content: [], stopReason: "error" }],
    [
      "aborted",
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "cancelled by operator",
      },
    ],
    ["string", "not a terminal result"],
    ["missing", { role: "assistant", content: [] }],
    ["unknown", { role: "assistant", content: [], stopReason: "future-provider-stop" }],
  ] as const)("classifies raw result terminal %s conservatively", async (name, result) => {
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => result) as unknown as StreamFn,
      {
        runId: `run-result-${name}`,
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => `call-result-${name}`,
      },
    );

    const events = await collectModelCallEvents(async () => {
      await wrapped({} as never, {} as never, {});
    });

    const succeeds = name === "stop" || name === "length" || name === "toolUse";
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      succeeds ? "model.call.completed" : "model.call.error",
    ]);
    if (name === "aborted") {
      expect(getEvent(events, 1)).toMatchObject({
        errorCategory: "Error",
        failureKind: "aborted",
      });
    }
  });

  it("fails natural iterator exhaustion without a terminal event", async () => {
    async function* stream() {
      yield { type: "text_delta", delta: "partial" };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-exhausted",
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-exhausted",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {}) as AsyncIterable<unknown>);
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    expect(getEvent(events, 1).errorCategory).toBe("Error");
  });

  it("defers natural iterator exhaustion to the authoritative result()", async () => {
    const assistant = completedAssistantMessage("authoritative result");
    const originalStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "partial" };
      },
      result: vi.fn(async () => assistant),
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => originalStream) as unknown as StreamFn,
      {
        runId: "run-deferred-result",
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-deferred-result",
      },
    );
    const events: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.")) {
        events.push(event);
      }
    });

    try {
      const observed = wrapped({} as never, {} as never, {}) as unknown as typeof originalStream;
      await drain(observed);
      await waitForDiagnosticEventsDrained();
      expect(events.map((event) => event.type)).toEqual(["model.call.started"]);

      expect(await observed.result()).toBe(assistant);
      await waitForDiagnosticEventsDrained();
      expect(events.map((event) => event.type)).toEqual([
        "model.call.started",
        "model.call.completed",
      ]);
    } finally {
      stop();
    }
  });

  it("fails a nonterminal result after deferred iterator exhaustion", async () => {
    const nonterminal = { role: "assistant", content: [] };
    const originalStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "partial" };
      },
      result: vi.fn(async () => nonterminal),
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => originalStream) as unknown as StreamFn,
      {
        runId: "run-deferred-nonterminal",
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-deferred-nonterminal",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const observed = wrapped({} as never, {} as never, {}) as unknown as typeof originalStream;
      await drain(observed);
      expect(await observed.result()).toBe(nonterminal);
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    expect(getEvent(events, 1).errorCategory).toBe("Error");
  });

  it("fails when authoritative result() rejects after iterator exhaustion", async () => {
    const resultError = new Error("authoritative result failed");
    const originalStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", delta: "partial" };
      },
      result: vi.fn(async () => {
        throw resultError;
      }),
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => originalStream) as unknown as StreamFn,
      {
        runId: "run-deferred-result-error",
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-deferred-result-error",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const observed = wrapped({} as never, {} as never, {}) as unknown as typeof originalStream;
      await drain(observed);
      await expect(observed.result()).rejects.toBe(resultError);
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    expect(getEvent(events, 1).errorCategory).toBe("Error");
  });

  it("rethrows iterator failure and emits a failed terminal", async () => {
    const iteratorError = new Error("iterator failed");
    const originalStream = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw iteratorError;
          },
        };
      },
      result: vi.fn(async () => completedAssistantMessage()),
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => originalStream) as unknown as StreamFn,
      {
        runId: "run-iterator-error",
        provider: "openai",
        model: "gpt-test",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-iterator-error",
      },
    );

    const events = await collectModelCallEvents(async () => {
      const observed = wrapped({} as never, {} as never, {}) as unknown as typeof originalStream;
      await expect(drain(observed)).rejects.toBe(iteratorError);
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    expect(getEvent(events, 1).errorCategory).toBe("Error");
  });

  it("skips prompt stat computation when diagnostics are disabled", async () => {
    // Prompt stats are only attached to diagnostic events; when diagnostics are
    // off those events are dropped, so the JSON.stringify of input messages and
    // tool definitions must not run on the model-call hot path.
    setDiagnosticsEnabledForProcess(false);
    let promptInspected = false;
    const streamContext = {
      systemPrompt: "system",
      get messages() {
        promptInspected = true;
        return [{ role: "user", content: "x", timestamp: 1 }];
      },
      get tools() {
        promptInspected = true;
        return [{ name: "lookup", description: "d", parameters: { type: "object" } }];
      },
    };
    async function* stream() {
      yield { type: "text_delta", delta: "ok" };
      yield completedTerminalEvent();
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-disabled-prompt-stats",
      },
    );

    await drain(
      wrapped({} as never, streamContext as never, {} as never) as AsyncIterable<unknown>,
    );

    expect(promptInspected).toBe(false);
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
    const collector = createProviderTransportAccountingCollector();
    let returnCalled = false;
    const doneEvent = completedTerminalEvent("ok");
    const stream = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              observeAttempt({
                callId: "call-cleanup",
                provider: "openai",
                model: "gpt-5.4",
                api: "openai-responses",
                transport: "http",
                outcome: "completed",
              });
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
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-cleanup",
      },
    );

    const events = await collectModelCallEvents(async () =>
      runWithProviderTransportAccountingObserver(collector.observer, async () => {
        const response = wrapped({} as never, {} as never, {} as never) as unknown as typeof stream;
        for await (const event of response as AsyncIterable<{ type: string }>) {
          if (event.type === "done") {
            await (response as { result: () => Promise<unknown> }).result();
            break;
          }
        }
      }),
    );

    expect(returnCalled).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 1,
          failed: 0,
          aborted: 0,
          entries: [{ callId: "call-cleanup", outcome: "completed" }],
        },
      },
    });
  });

  it("settles result-only error messages as failed calls", async () => {
    const collector = createProviderTransportAccountingCollector();
    const assistant = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider rejected the request",
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        observeAttempt({
          callId: "call-result-error",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          outcome: "failed",
        });
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true };
              },
            };
          },
          result: async () => assistant,
        };
      }) as unknown as StreamFn,
      {
        runId: "run-result-error",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-result-error",
      },
    );

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      const stream = wrapped({} as never, {} as never, {}) as unknown as {
        result: () => Promise<unknown>;
      };
      await stream.result();
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 0,
          failed: 1,
          aborted: 0,
          entries: [{ callId: "call-result-error", outcome: "failed" }],
        },
      },
    });
  });

  it("settles an unknown result stop reason as a failed call", async () => {
    const collector = createProviderTransportAccountingCollector();
    const assistant = {
      role: "assistant",
      content: [],
      stopReason: "future-provider-stop",
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        observeAttempt({
          callId: "call-result-unknown-stop",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          outcome: "failed",
        });
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true };
              },
            };
          },
          result: async () => assistant,
        };
      }) as unknown as StreamFn,
      {
        runId: "run-result-unknown-stop",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-result-unknown-stop",
      },
    );

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      const stream = wrapped({} as never, {} as never, {}) as unknown as {
        result: () => Promise<unknown>;
      };
      await stream.result();
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ callId: "call-result-unknown-stop", outcome: "failed" }],
        },
      },
    });
  });

  it("settles an unknown done stop reason as a failed call", async () => {
    const collector = createProviderTransportAccountingCollector();
    async function* stream() {
      observeAttempt({
        callId: "call-done-unknown-stop",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        outcome: "failed",
      });
      yield {
        type: "done",
        message: { role: "assistant", content: [], stopReason: "future-provider-stop" },
      };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-done-unknown-stop",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-done-unknown-stop",
      },
    );

    await runWithProviderTransportAccountingObserver(collector.observer, async () => {
      await drain(wrapped({} as never, {} as never, {}) as AsyncIterable<unknown>);
    });

    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ callId: "call-done-unknown-stop", outcome: "failed" }],
        },
      },
    });
  });

  it("settles result-only aborted messages as aborted calls", async () => {
    const collector = createProviderTransportAccountingCollector();
    const assistant = {
      role: "assistant",
      content: [],
      stopReason: "aborted",
      errorMessage: "operator aborted",
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        observeAttempt({
          callId: "call-result-aborted",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          outcome: "aborted",
        });
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { value: undefined, done: true };
              },
            };
          },
          result: async () => assistant,
        };
      }) as unknown as StreamFn,
      {
        runId: "run-result-aborted",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-result-aborted",
      },
    );

    const events = await collectModelCallEvents(async () =>
      runWithProviderTransportAccountingObserver(collector.observer, async () => {
        const stream = wrapped({} as never, {} as never, {}) as unknown as {
          result: () => Promise<unknown>;
        };
        await stream.result();
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          aborted: 1,
          entries: [{ callId: "call-result-aborted", outcome: "aborted" }],
        },
      },
    });
  });

  it("keeps terminal accounting observational when provider getters throw", async () => {
    const collector = createProviderTransportAccountingCollector();
    const assistant = {
      role: "assistant",
      content: [],
      stopReason: "error",
      get errorMessage(): string {
        throw new Error("unsafe provider getter");
      },
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        observeAttempt({
          callId: "call-terminal-getter",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          outcome: "failed",
        });
        return assistant;
      }) as unknown as StreamFn,
      {
        runId: "run-terminal-getter",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-terminal-getter",
      },
    );

    await expect(
      runWithProviderTransportAccountingObserver(collector.observer, async () =>
        wrapped({} as never, {} as never, {}),
      ),
    ).resolves.toBe(assistant);
    expect(collector.project()).toMatchObject({
      snapshot: {
        logicalCalls: {
          failed: 1,
          entries: [{ callId: "call-terminal-getter", outcome: "failed" }],
        },
      },
    });
  });

  it("propagates the trusted model-call traceparent without mutating caller headers", async () => {
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const capturedOptions: Array<Parameters<StreamFn>[2]> = [];
    const callerOptions = {
      headers: {
        "X-Custom": "kept",
        TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
      sessionId: "provider-session",
    };
    const exportedTrace = createDiagnosticTraceContext({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: "01",
    });
    registerDiagnosticTracePropagationBridge({
      resolveTraceContext: () => exportedTrace,
    });
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        _model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        capturedOptions.push(options);
        return stream();
      }) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: "01",
        }),
        nextCallId: () => "call-traceparent",
      },
    );

    await drain(
      wrapped({} as never, {} as never, callerOptions) as unknown as AsyncIterable<unknown>,
    );

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]).not.toBe(callerOptions);
    const capturedOption = requireRecord(capturedOptions[0], "captured stream options");
    expect(capturedOption.sessionId).toBe("provider-session");
    expect(capturedOption.requestId).toBe("call-traceparent");
    const headers = readRecordField(capturedOption, "headers", "captured stream headers");
    expect(headers["X-Custom"]).toBe("kept");
    expect(headers.traceparent).toBe(`00-${exportedTrace.traceId}-${exportedTrace.spanId}-01`);
    expect(capturedOptions[0]?.headers).not.toHaveProperty("TraceParent");
    expect(callerOptions.headers).toEqual({
      "X-Custom": "kept",
      TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
  });

  it("removes caller traceparent when the active exporter cannot resolve a span", async () => {
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const capturedOptions: Array<Parameters<StreamFn>[2]> = [];
    registerDiagnosticTracePropagationBridge({
      resolveTraceContext: () => undefined,
    });
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        _model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        capturedOptions.push(options);
        return stream();
      }) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-no-exported-span",
      },
    );

    await drain(
      wrapped({} as never, {} as never, {
        headers: {
          "X-Custom": "kept",
          TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        },
      }) as unknown as AsyncIterable<unknown>,
    );

    expect(capturedOptions[0]?.headers).toEqual({ "X-Custom": "kept" });
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

  it("settles aborted model calls separately from provider failures", async () => {
    const collector = createProviderTransportAccountingCollector();
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        observeAttempt({
          callId: "call-aborted",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          outcome: "aborted",
        });
        throw new Error("operation was aborted");
      }) as unknown as StreamFn,
      {
        runId: "run-aborted",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-aborted",
      },
    );

    await expect(
      runWithProviderTransportAccountingObserver(collector.observer, async () => {
        await wrapped({} as never, {} as never, {});
      }),
    ).rejects.toThrow("operation was aborted");

    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 0,
          failed: 0,
          aborted: 1,
          entries: [{ callId: "call-aborted", outcome: "aborted" }],
        },
      },
    });
  });

  it("adds failure kind and memory diagnostics for terminated model calls", async () => {
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            throw new Error("terminated");
          },
        };
      },
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "lmstudio",
        model: "qwen/qwen3.5-9b",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-terminated",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await expect(
        drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>),
      ).rejects.toThrow("terminated");
    });

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.callId).toBe("call-terminated");
    expect(errorEvent.errorCategory).toBe("Error");
    expect(errorEvent.failureKind).toBe("terminated");
    const memory = readRecordField(errorEvent, "memory", "error event memory");
    expectNumberField(memory, "rssBytes");
    expectNumberField(memory, "heapTotalBytes");
    expectNumberField(memory, "heapUsedBytes");
    expectNumberField(memory, "externalBytes");
    expectNumberField(memory, "arrayBuffersBytes");
  });

  it("does not mutate non-configurable provider streams", async () => {
    const stream = {};
    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: false,
      async *value() {
        yield { type: "text", text: "ok" };
        yield completedTerminalEvent();
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

  it("fires frozen sanitized model-call plugin hooks", async () => {
    const started = vi.fn();
    const ended = vi.fn();
    const { registry } = createHookRunnerWithRegistry([
      { hookName: "model_call_started", handler: started },
      { hookName: "model_call_ended", handler: ended },
    ]);
    initializeGlobalHookRunner(registry);
    const secretChunk = "secret response with Bearer sk-test-secret-value";

    async function* stream() {
      yield { type: "text", text: secretChunk };
      yield completedTerminalEvent();
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
        contextTokenBudget: 150_000,
        contextWindowSource: "agentContextTokens",
        contextWindowReferenceTokens: 200_000,
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-hook",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    const startedEvent = requireMockRecordArg(started, 0, 0, "started hook event");
    expect(startedEvent.runId).toBe("run-1");
    expect(startedEvent.callId).toBe("call-hook");
    expect(startedEvent.sessionKey).toBe("session-key");
    expect(startedEvent.sessionId).toBe("session-id");
    expect(startedEvent.provider).toBe("openai");
    expect(startedEvent.model).toBe("gpt-5.4");
    expect(startedEvent.api).toBe("openai-responses");
    expect(startedEvent.transport).toBe("http");
    expect(startedEvent.contextTokenBudget).toBe(150_000);
    expect(startedEvent.contextWindowSource).toBe("agentContextTokens");
    expect(startedEvent.contextWindowReferenceTokens).toBe(200_000);
    const startedCtx = requireMockRecordArg(started, 0, 1, "started hook context");
    expect(startedCtx.runId).toBe("run-1");
    expect(startedCtx.sessionKey).toBe("session-key");
    expect(startedCtx.sessionId).toBe("session-id");
    expect(startedCtx.modelProviderId).toBe("openai");
    expect(startedCtx.modelId).toBe("gpt-5.4");
    expect(startedCtx.contextTokenBudget).toBe(150_000);
    expect(startedCtx.contextWindowSource).toBe("agentContextTokens");
    expect(startedCtx.contextWindowReferenceTokens).toBe(200_000);
    const endedEvent = requireMockRecordArg(ended, 0, 0, "ended hook event");
    expect(endedEvent.runId).toBe("run-1");
    expect(endedEvent.callId).toBe("call-hook");
    expect(endedEvent.outcome).toBe("completed");
    expect(endedEvent.contextTokenBudget).toBe(150_000);
    expect(endedEvent.contextWindowSource).toBe("agentContextTokens");
    expect(endedEvent.contextWindowReferenceTokens).toBe(200_000);
    expectNumberField(endedEvent, "durationMs");
    expectNumberField(endedEvent, "responseStreamBytes");
    expectNumberField(endedEvent, "timeToFirstByteMs");
    const endedCtx = requireMockRecordArg(ended, 0, 1, "ended hook context");
    expect(endedCtx.runId).toBe("run-1");
    expect(Object.isFrozen(startedEvent)).toBe(true);
    expect(Object.isFrozen(startedCtx)).toBe(true);
    expect(Object.isFrozen(startedCtx.trace)).toBe(true);
    expect(JSON.stringify([started.mock.calls, ended.mock.calls])).not.toContain(secretChunk);
  });

  it("keeps core model-call diagnostics while suppressing finalization plugin hooks", async () => {
    const started = vi.fn();
    const ended = vi.fn();
    const { registry } = createHookRunnerWithRegistry([
      { hookName: "model_call_started", handler: started },
      { hookName: "model_call_ended", handler: ended },
    ]);
    initializeGlobalHookRunner(registry);
    async function* stream() {
      yield { type: "text", text: "final answer" };
      yield completedTerminalEvent();
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-finalization",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-finalization",
        suppressPluginHooks: true,
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    expect(started).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("classifies a consumer break through the AbortError ABORT_ERR contract", async () => {
    const collector = createProviderTransportAccountingCollector();
    async function* stream() {
      try {
        yield { type: "text", text: "first" };
        yield { type: "text", text: "second" };
      } finally {
        observeAttempt({
          callId: "call-abandoned",
          provider: "openai",
          model: "gpt-5.4",
          api: "openai-responses",
          transport: "http",
          outcome: "aborted",
        });
      }
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-abandoned",
      },
    );

    const events = await collectModelCallEvents(async () =>
      runWithProviderTransportAccountingObserver(collector.observer, async () => {
        for await (const _ of wrapped(
          {} as never,
          {} as never,
          {} as never,
        ) as AsyncIterable<unknown>) {
          break;
        }
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["model.call.started", "model.call.error"]);
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.callId).toBe("call-abandoned");
    expect(errorEvent.errorCategory).toBe("Error");
    expect(errorEvent.failureKind).toBe("aborted");
    expectNumberField(errorEvent, "durationMs");
    expect(collector.project()).toMatchObject({
      coverage: { state: "complete" },
      snapshot: {
        logicalCalls: {
          total: 1,
          completed: 0,
          failed: 0,
          aborted: 1,
          entries: [{ callId: "call-abandoned", outcome: "aborted" }],
        },
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
