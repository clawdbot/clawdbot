import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-helpers.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

async function collectModelCallEvents(run: () => Promise<void>): Promise<DiagnosticEventPayload[]> {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("model.call.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    return events;
  } finally {
    stop();
  }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // drain
  }
}

describe("wrapStreamFnWithDiagnosticModelCallEvents", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("emits started and completed events for async streams", async () => {
    async function* stream() {
      yield { type: "text", text: "ok" };
    }
    const originalStream = stream() as unknown as AsyncIterable<unknown> & {
      result: () => Promise<string>;
    };
    originalStream.result = async () => "kept";
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => originalStream) as unknown as StreamFn,
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
      expect(await returned.result()).toBe("kept");
      await drain(returned);
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      transport: "http",
    });
    expect(events[0]?.trace?.parentSpanId).toBe("00f067aa0ba902b7");
    expect(events[1]).toMatchObject({
      type: "model.call.completed",
      callId: "call-1",
      durationMs: expect.any(Number),
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
    expect(capturedOptions[0]).toMatchObject({
      sessionId: "provider-session",
      headers: {
        "X-Custom": "kept",
        traceparent: expect.stringMatching(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/),
      },
    });
    expect(capturedOptions[0]?.headers).not.toHaveProperty("TraceParent");
    expect(callerOptions.headers).toEqual({
      "X-Custom": "kept",
      TraceParent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    });
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
    expect(events[1]).toMatchObject({
      type: "model.call.error",
      callId: "call-err",
      errorCategory: "TypeError",
      upstreamRequestIdHash: expect.stringMatching(/^sha256:[a-f0-9]{12}$/),
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(events[1])).not.toContain(requestId);
  });

  it("does not mutate non-configurable provider streams", async () => {
    const stream = {};
    Object.defineProperty(stream, Symbol.asyncIterator, {
      configurable: false,
      value: async function* () {
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
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-hook",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        callId: "call-hook",
        sessionKey: "session-key",
        sessionId: "session-id",
        provider: "openai",
        model: "gpt-5.4",
        api: "openai-responses",
        transport: "http",
      }),
      expect.objectContaining({
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        modelProviderId: "openai",
        modelId: "gpt-5.4",
      }),
    );
    expect(ended).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        callId: "call-hook",
        outcome: "completed",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({ runId: "run-1" }),
    );
    const startedEvent = started.mock.calls[0]?.[0];
    const startedCtx = started.mock.calls[0]?.[1];
    expect(Object.isFrozen(startedEvent)).toBe(true);
    expect(Object.isFrozen(startedCtx)).toBe(true);
    expect(Object.isFrozen((startedCtx as { trace?: unknown } | undefined)?.trace)).toBe(true);
    expect(JSON.stringify([started.mock.calls, ended.mock.calls])).not.toContain(secretChunk);
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
    expect(events[1]).toMatchObject({
      type: "model.call.completed",
      callId: "call-abandoned",
      durationMs: expect.any(Number),
    });
    expect(events[1]).not.toHaveProperty("errorCategory");
  });
});
