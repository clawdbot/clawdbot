// Coverage for model-call diagnostic events around attempt stream functions.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
  waitForDiagnosticEventsDrained,
} from "../../../infra/diagnostic-events.js";
import { isCoreSemanticRunProgressDiagnosticMetadata } from "../../../infra/diagnostic-semantic-run-progress.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

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

async function collectSemanticProgressEvents(run: () => Promise<void>) {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (
      isCoreSemanticRunProgressDiagnosticMetadata(metadata) &&
      event.type === "run.progress" &&
      event.reason === "model_call:semantic_result"
    ) {
      events.push(event);
    }
  });
  try {
    await run();
    await waitForDiagnosticEventsDrained();
    return events;
  } finally {
    stop();
  }
}

function assistantResult(stopReason: string, content: unknown[]) {
  return { role: "assistant", stopReason, content };
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

describe("wrapStreamFnWithDiagnosticModelCallEvents observation", () => {
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

  it.each([
    {
      name: "visible text",
      result: assistantResult("stop", [{ type: "text", text: "done" }]),
      expected: 1,
    },
    {
      name: "tool-use call",
      result: assistantResult("toolUse", [
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      ]),
      expected: 1,
    },
    {
      name: "error text",
      result: assistantResult("error", [{ type: "text", text: "provider failed" }]),
      expected: 0,
    },
    {
      name: "aborted text",
      result: assistantResult("aborted", [{ type: "text", text: "partial" }]),
      expected: 0,
    },
    {
      name: "reasoning only",
      result: assistantResult("stop", [{ type: "thinking", thinking: "working" }]),
      expected: 0,
    },
    {
      name: "blank text",
      result: assistantResult("stop", [{ type: "text", text: "  \n" }]),
      expected: 0,
    },
    {
      name: "non-executable tool block",
      result: assistantResult("stop", [
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ]),
      expected: 0,
    },
    {
      name: "malformed tool-use call",
      result: assistantResult("toolUse", [{ type: "toolCall", id: "", name: "read" }]),
      expected: 0,
    },
  ])("emits semantic progress once for $name final results", async ({ result, expected }) => {
    const stream = {
      async *[Symbol.asyncIterator]() {},
      result: async () => result,
    };
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => stream) as unknown as StreamFn,
      {
        runId: "run-semantic-result",
        sessionId: "session-semantic-result",
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => "call-semantic-result",
      },
    );

    const events = await collectSemanticProgressEvents(async () => {
      const observed = wrapped({} as never, {} as never, {} as never) as unknown as typeof stream;
      await observed.result();
      await observed.result();
    });

    expect(events).toHaveLength(expected);
  });

  it("orders semantic results between repeated request observations", async () => {
    const ref = {
      sessionId: "session-semantic-order",
      sessionKey: "agent:main:semantic-order",
    };
    const runId = "run-semantic-order";
    const results = [
      assistantResult("error", [{ type: "text", text: "retry one" }]),
      assistantResult("error", [{ type: "text", text: "retry two" }]),
      assistantResult("stop", [{ type: "text", text: "made progress" }]),
      assistantResult("error", [{ type: "text", text: "retry after progress" }]),
    ];
    let callSequence = 0;
    const wrapped = wrapStreamFnWithDiagnosticModelCallEvents(
      (() => {
        const result = results.shift();
        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => result,
        };
      }) as unknown as StreamFn,
      {
        ...ref,
        runId,
        provider: "openai",
        model: "gpt-5.4",
        trace: createDiagnosticTraceContext(),
        nextCallId: () => `${runId}:${(callSequence += 1)}`,
      },
    );
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });

    const repeatedRequestAges: Array<number | undefined> = [];
    for (let index = 0; index < 4; index += 1) {
      const observed = wrapped({} as never, {} as never, {} as never) as unknown as {
        result: () => Promise<unknown>;
      };
      await observed.result();
      await waitForDiagnosticEventsDrained();
      repeatedRequestAges.push(
        getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
      );
    }

    expect(repeatedRequestAges).toEqual([undefined, expect.any(Number), undefined, undefined]);

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      hasActiveEmbeddedRun: true,
      repeatedRequestNoProgressAgeMs: undefined,
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
      expect(runProgressEvents.every((event) => event.type === "run.progress")).toBe(true);
      expect(runProgressEvents.every((event) => !("progressKind" in event))).toBe(true);
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
});
