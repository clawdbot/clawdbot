import { readFileSync } from "node:fs";
import { join } from "node:path";
// Coverage for model-call diagnostic events around attempt stream functions.
import { notifyProviderStreamOpened } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { registerDiagnosticTracePropagationBridge } from "../../../infra/diagnostic-trace-propagation.js";
import { flushDiagnosticsTimeline } from "../../../infra/diagnostics-timeline.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { makeZeroUsageSnapshot } from "../../usage.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

const tempDirs = createTempDirTracker();

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

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  // Force stream iteration so completion events include response byte and timing
  // accounting.
  for await (const _ of stream) {
    // drain
  }
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
  flushDiagnosticsTimeline();
  return readFileSync(timelinePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => requireRecord(JSON.parse(line), "provider timeline event"))
    .filter((event) => event.type === "provider.request");
}

describe("wrapStreamFnWithDiagnosticModelCallEvents lifecycle", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
    startDiagnosticRunActivityTracking();
    resetGlobalHookRunner();
  });

  afterEach(() => {
    flushDiagnosticsTimeline();
    tempDirs.cleanup();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["stop", "error"] as const)(
    "notifies terminal %s once when an explicit result follows iterator exhaustion",
    async (stopReason) => {
      const onTerminal = vi.fn();
      const onSucceeded = vi.fn();
      const originalStream = createAssistantMessageEventStream();
      originalStream.end({
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.4",
        stopReason,
        usage: makeZeroUsageSnapshot(),
        timestamp: 0,
      });
      const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(() => originalStream, {
        runId: "run-explicit-result",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-explicit-result",
        onTerminal,
        onSucceeded,
      });
      const events = await collectModelCallEvents(async () => {
        const response = await wrapped({} as never, { messages: [] });
        await drain(response);
        expect(onTerminal).not.toHaveBeenCalled();
        expect(onSucceeded).not.toHaveBeenCalled();
        await response.result();
        await response.result();
        await drain(response);
      });
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(onSucceeded).toHaveBeenCalledTimes(stopReason === "stop" ? 1 : 0);
      expect(events.filter((event) => event.type === "model.call.completed")).toHaveLength(1);
    },
  );

  it.each(["stop", "error"])(
    "emits one %s provider timeline event for result and iterator completion",
    async (stopReason) => {
      let now = Date.parse("2026-07-09T18:30:00.000Z");
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const assistant = { role: "assistant", stopReason, errorMessage: "request timed out" };
      async function* stream() {
        yield stopReason === "error"
          ? { type: "error", error: assistant }
          : { type: "done", message: assistant };
      }
      const originalStream = stream() as unknown as AsyncIterable<unknown> & {
        result: () => Promise<typeof assistant>;
      };
      originalStream.result = async () => {
        now += 125;
        return assistant;
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
        ok: stopReason === "stop",
        attributes: {
          model: "gpt-5.5",
          api: "openai-responses",
          transport: "http",
        },
      });
      expect(events[0]?.status).toBeUndefined();
    },
  );

  it("records legacy response status without inferring provider acceptance", async () => {
    const originalOnResponse = vi.fn(async () => undefined);
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        return options?.onResponse?.({ status: 200, headers: { "x-request-id": "req-1" } }, model);
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
      attributes: {
        providerAccepted: false,
      },
    });
  });

  it("records provider acceptance when an SDK hides HTTP metadata", async () => {
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      ((
        _model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => notifyProviderStreamOpened({ options, cancelStream: vi.fn() })) as unknown as StreamFn,
      {
        runId: "run-timeline-accepted",
        provider: "google",
        model: "gemini-2.5-pro",
        api: "google-generative-ai",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-timeline-accepted",
      },
    );

    const events = await collectProviderTimelineEvents(async () => {
      await wrapped({ id: "gemini-2.5-pro" } as never, {} as never, {});
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "provider.request",
      ok: true,
      attributes: {
        providerAccepted: true,
        providerAcceptanceKind: "provider_stream_opened",
      },
    });
    expect(events[0]?.status).toBeUndefined();
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
          (() => undefined) as unknown as StreamFn,
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

  it.each(["stop", "error"])(
    "fires frozen sanitized model-call plugin hooks for %s",
    async (stopReason) => {
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
        if (stopReason === "error") {
          yield {
            type: "error",
            error: { role: "assistant", stopReason, errorMessage: secretChunk },
          };
        }
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
          contextWindowSource: "modelsConfig",
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
        stopReason === "error" ? "model.call.error" : "model.call.completed",
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
      expect(startedEvent.contextWindowSource).toBe("modelsConfig");
      expect(startedEvent.contextWindowReferenceTokens).toBe(200_000);
      const startedCtx = requireMockRecordArg(started, 0, 1, "started hook context");
      expect(startedCtx.runId).toBe("run-1");
      expect(startedCtx.sessionKey).toBe("session-key");
      expect(startedCtx.sessionId).toBe("session-id");
      expect(startedCtx.modelProviderId).toBe("openai");
      expect(startedCtx.modelId).toBe("gpt-5.4");
      expect(startedCtx.contextTokenBudget).toBe(150_000);
      expect(startedCtx.contextWindowSource).toBe("modelsConfig");
      expect(startedCtx.contextWindowReferenceTokens).toBe(200_000);
      const endedEvent = requireMockRecordArg(ended, 0, 0, "ended hook event");
      expect(endedEvent.runId).toBe("run-1");
      expect(endedEvent.callId).toBe("call-hook");
      expect(endedEvent.outcome).toBe(stopReason === "error" ? "error" : "completed");
      expect(ended).toHaveBeenCalledOnce();
      expect(endedEvent.contextTokenBudget).toBe(150_000);
      expect(endedEvent.contextWindowSource).toBe("modelsConfig");
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
    },
  );

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
});
