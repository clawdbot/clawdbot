// Coverage for model-call diagnostic events around attempt stream functions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
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
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
} from "../../../logging/diagnostic-run-activity.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../plugins/hook-runner-global.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-helpers.js";
import { withEnvAsync } from "../../../test-utils/env.js";
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

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

describe("wrapStreamFnWithDiagnosticModelCallEvents", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
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
    const originalStream = stream() as unknown as AsyncIterable<unknown> & {
      result: () => Promise<string>;
    };
    originalStream.result = async () => {
      now += 125;
      return "kept";
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
    expect(completedEvent.responseStreamBytes).toBe(Buffer.byteLength("abc", "utf8"));
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
    async function* stream() {
      yield opaqueChunk;
      yield { type: "text_delta", delta: "ok" };
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

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(opaqueChunk);
    expect(chunks[1]).toEqual({ type: "text_delta", delta: "ok" });
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.responseStreamBytes).toBe(Buffer.byteLength("ok", "utf8"));
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
    async function* stream() {
      yield { type: "error", reason: "aborted", error: assistant };
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openrouter",
        model: "openrouter/auto",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-error-usage",
      },
    );

    const events = await collectModelCallEvents(async () => {
      await drain(wrapped({} as never, {} as never, {} as never) as AsyncIterable<unknown>);
    });

    // An in-band error event is data, not a throw, so iteration completes
    // normally; the per-call usage rides on the terminal completion event.
    const completedEvent = getEvent(events, 1);
    expect(completedEvent.type).toBe("model.call.completed");
    expect(completedEvent.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      reasoningTokens: 5,
      total: 28,
      promptTokens: 16,
    });
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
    }
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream()) as unknown as StreamFn,
      {
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
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
    const capturedOption = requireRecord(capturedOptions[0], "captured stream options");
    expect(capturedOption.sessionId).toBe("provider-session");
    const headers = readRecordField(capturedOption, "headers", "captured stream headers");
    expect(headers["X-Custom"]).toBe("kept");
    expect(typeof headers.traceparent).toBe("string");
    expect(headers.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
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
    const errorEvent = getEvent(events, 1);
    expect(errorEvent.type).toBe("model.call.error");
    expect(errorEvent.callId).toBe("call-err");
    expect(errorEvent.errorCategory).toBe("TypeError");
    expect(typeof errorEvent.upstreamRequestIdHash).toBe("string");
    expect(errorEvent.upstreamRequestIdHash).toMatch(/^sha256:[a-f0-9]{12}$/);
    expectNumberField(errorEvent, "durationMs");
    expect(JSON.stringify(events[1])).not.toContain(requestId);
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
