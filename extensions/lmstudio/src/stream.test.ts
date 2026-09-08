import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
// Lmstudio tests cover stream plugin behavior.
import { createRequireRecord, createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let wrapLmstudioInferencePreload: typeof import("./stream.js").wrapLmstudioInferencePreload;
let defaultBaseUrl: string;
let defaultBaseUrlSequence = 0;

const prepareLmstudioModelForInferenceMock = vi.hoisted(() => vi.fn());
const resolveLmstudioProviderHeadersMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const resolveLmstudioRuntimeApiKeyMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);

vi.mock("./models.fetch.js", () => ({
  prepareLmstudioModelForInference: (params: unknown) =>
    prepareLmstudioModelForInferenceMock(params),
}));

vi.mock("./runtime.js", () => ({
  resolveLmstudioProviderHeaders: (params: unknown) => resolveLmstudioProviderHeadersMock(params),
  resolveLmstudioRuntimeApiKey: (params: unknown) => resolveLmstudioRuntimeApiKeyMock(params),
}));

beforeAll(async () => {
  ({ wrapLmstudioInferencePreload } = await import("./stream.js"));
});

type StreamEvent = { type: string } & Record<string, unknown>;

const requireRecord = createRequireRecord("record", "expected-label-record");

function lmstudioAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant" as const,
    content,
    api: "openai-completions" as const,
    provider: "lmstudio",
    model: "qwen3-8b-instruct",
    usage: createZeroUsageFixture(),
    stopReason: "stop" as const,
    timestamp: 1,
  };
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectSingleDoneEvent(events: StreamEvent[]) {
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("done");
}

function requireMockCallArg(mock: { mock: { calls: unknown[][] } }, label: string) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function expectEnsureLoadedFields(fields: Record<string, unknown>) {
  const [params] = requireMockCallArg(
    prepareLmstudioModelForInferenceMock,
    "ensureLmstudioModelLoaded",
  );
  const record = requireRecord(params, "ensureLmstudioModelLoaded params");
  for (const [key, value] of Object.entries(fields)) {
    if (key === "ssrfPolicy") {
      expectRecordFields(
        requireRecord(record.ssrfPolicy, "ssrfPolicy"),
        value as Record<string, unknown>,
      );
    } else {
      expect(record[key]).toEqual(value);
    }
  }
}

function expectBaseStreamModelFields(baseStream: StreamFn, fields: Record<string, unknown>) {
  const call = requireMockCallArg(
    baseStream as unknown as { mock: { calls: unknown[][] } },
    "base stream",
  );
  expectRecordFields(requireRecord(call[0], "base stream model"), fields);
  if (call[1] === undefined) {
    throw new Error("Expected base stream context");
  }
  expect(call[2]).toBeUndefined();
}

function expectBaseStreamCallModelFields(
  baseStream: StreamFn,
  callIndex: number,
  fields: Record<string, unknown>,
) {
  const call = (baseStream as unknown as { mock: { calls: unknown[][] } }).mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected base stream call ${callIndex}`);
  }
  expectRecordFields(requireRecord(call[0], "base stream model"), fields);
}

async function collectEvents(stream: ReturnType<StreamFn>): Promise<StreamEvent[]> {
  const resolved = stream instanceof Promise ? await stream : stream;
  const events: StreamEvent[] = [];
  for await (const event of resolved) {
    events.push(event as StreamEvent);
  }
  return events;
}

function buildDoneStreamFn(): StreamFn {
  return vi.fn((_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: lmstudioAssistantMessage([]) });
      stream.end();
    });
    return stream;
  });
}

function buildEventStreamFn(events: unknown[]): StreamFn {
  return vi.fn((_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      for (const event of events) {
        stream.push(event as never);
      }
      stream.end();
    });
    return stream;
  });
}

function createWrappedLmstudioStream(
  baseStream: StreamFn,
  params?: { baseUrl?: string; thinkingLevel?: string },
): StreamFn {
  return wrapLmstudioInferencePreload({
    provider: "lmstudio",
    modelId: "qwen3-8b-instruct",
    config: {
      models: {
        providers: {
          lmstudio: {
            baseUrl: params?.baseUrl ?? defaultBaseUrl,
            models: [],
          },
        },
      },
    },
    streamFn: baseStream,
    thinkingLevel: params?.thinkingLevel,
  } as never);
}

function buildPayloadStreamFn(payload: Record<string, unknown>): StreamFn {
  return vi.fn((model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      options?.onPayload?.(payload, model);
      stream.push({ type: "done", reason: "stop", message: {} as never });
      stream.end();
    });
    return stream;
  });
}

const BINARY_REASONING_COMPAT = {
  supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
};

function runWrappedLmstudioStream(
  wrapped: StreamFn,
  model: Record<string, unknown>,
  options?: Record<string, unknown>,
  context?: Record<string, unknown>,
) {
  return wrapped(
    {
      provider: "lmstudio",
      api: "openai-completions",
      id: "lmstudio/qwen3-8b-instruct",
      ...model,
    } as never,
    { messages: [], ...context } as never,
    options as never,
  );
}

describe("lmstudio stream wrapper", () => {
  beforeEach(() => {
    // Production preload state is keyed by base URL, model, and context length.
    // Give each test a real cache namespace while preserving within-test reuse.
    defaultBaseUrl = `http://lmstudio-test-${defaultBaseUrlSequence++}.localhost:1234`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    prepareLmstudioModelForInferenceMock.mockReset();
    resolveLmstudioProviderHeadersMock.mockReset();
    resolveLmstudioRuntimeApiKeyMock.mockReset();
    resolveLmstudioProviderHeadersMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue(undefined);
  });

  it("preloads LM Studio model before inference using model context window", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream, {
      baseUrl: "http://lmstudio.internal:1234/v1",
    });
    const stream = runWrappedLmstudioStream(
      wrapped,
      { contextWindow: 131072 },
      { apiKey: "lmstudio-token" },
    );
    const events = await collectEvents(stream);

    expectSingleDoneEvent(events);
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);
    expectEnsureLoadedFields({
      baseUrl: "http://lmstudio.internal:1234/v1",
      modelKey: "qwen3-8b-instruct",
      requestedContextLength: 131072,
      apiKey: "lmstudio-token",
      ssrfPolicy: { allowedHostnames: ["lmstudio.internal"] },
    });
  });

  it("streams with the canonical model key returned by preload", async () => {
    prepareLmstudioModelForInferenceMock.mockResolvedValueOnce({
      modelKey: "gemma-4-e4b-it-ultra-uncensored-heretic",
    });
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const variantKey = "gemma-4-e4b-it-ultra-uncensored-heretic@q4_k_m";
    const stream = runWrappedLmstudioStream(wrapped, { id: `lmstudio/${variantKey}` });
    const events = await collectEvents(stream);

    expectSingleDoneEvent(events);
    expectEnsureLoadedFields({
      modelKey: variantKey,
      baseUrl: `${defaultBaseUrl}/v1`,
    });
    expectBaseStreamModelFields(baseStream, {
      provider: "lmstudio",
      id: "gemma-4-e4b-it-ultra-uncensored-heretic",
    });
  });

  it("prefers model contextTokens over contextWindow for preload requests", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream, {
      baseUrl: "http://lmstudio.internal:1234/v1",
    });
    const stream = runWrappedLmstudioStream(
      wrapped,
      { contextWindow: 131072, contextTokens: 64000 },
      { apiKey: "lmstudio-token" },
    );
    const events = await collectEvents(stream);

    expectSingleDoneEvent(events);
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);
    expectEnsureLoadedFields({
      baseUrl: "http://lmstudio.internal:1234/v1",
      modelKey: "qwen3-8b-instruct",
      requestedContextLength: 64000,
      apiKey: "lmstudio-token",
      ssrfPolicy: { allowedHostnames: ["lmstudio.internal"] },
    });
  });

  it("omits malformed preload context lengths", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream, {
      baseUrl: "http://lmstudio.internal:1234/v1",
    });
    const stream = runWrappedLmstudioStream(
      wrapped,
      {
        contextTokens: 64000.5,
        contextWindow: Number.POSITIVE_INFINITY,
      },
      { apiKey: "lmstudio-token" },
    );
    const events = await collectEvents(stream);

    expectSingleDoneEvent(events);
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);
    expectEnsureLoadedFields({
      baseUrl: "http://lmstudio.internal:1234/v1",
      modelKey: "qwen3-8b-instruct",
      requestedContextLength: undefined,
      apiKey: "lmstudio-token",
      ssrfPolicy: { allowedHostnames: ["lmstudio.internal"] },
    });
  });

  it("continues inference when preload fails", async () => {
    prepareLmstudioModelForInferenceMock.mockRejectedValueOnce(new Error("load failed"));
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: defaultBaseUrl,
              models: [],
            },
          },
        },
      },
      streamFn: baseStream,
    } as never);

    const stream = wrapped(
      {
        provider: "lmstudio",
        api: "openai-completions",
        id: "qwen3-8b-instruct",
      } as never,
      { messages: [] } as never,
      undefined as never,
    );
    const events = await collectEvents(stream);
    expectSingleDoneEvent(events);
    expect(baseStream).toHaveBeenCalledTimes(1);
  });

  it("streams with the canonical model key when preload fails after discovery", async () => {
    prepareLmstudioModelForInferenceMock.mockRejectedValueOnce(
      Object.assign(new Error("load failed"), {
        resolvedModelKey: "gemma-4-e4b-it-ultra-uncensored-heretic",
      }),
    );
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const stream = runWrappedLmstudioStream(wrapped, {
      id: "lmstudio/gemma-4-e4b-it-ultra-uncensored-heretic@q4_k_m",
    });
    const events = await collectEvents(stream);

    expectSingleDoneEvent(events);
    expect(baseStream).toHaveBeenCalledTimes(1);
    expectBaseStreamModelFields(baseStream, {
      provider: "lmstudio",
      id: "gemma-4-e4b-it-ultra-uncensored-heretic",
    });
  });

  it("reuses the canonical model key while preload failure cooldown is active", async () => {
    const canonicalKey = "gemma-4-e4b-it-ultra-uncensored-heretic";
    const variantModel = {
      id: `lmstudio/${canonicalKey}@q4_k_m`,
    };
    prepareLmstudioModelForInferenceMock.mockRejectedValueOnce(
      Object.assign(new Error("load failed"), {
        resolvedModelKey: canonicalKey,
      }),
    );
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);

    const firstEvents = await collectEvents(runWrappedLmstudioStream(wrapped, variantModel));
    const secondEvents = await collectEvents(runWrappedLmstudioStream(wrapped, variantModel));

    expectSingleDoneEvent(firstEvents);
    expectSingleDoneEvent(secondEvents);
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);
    expect(baseStream).toHaveBeenCalledTimes(2);
    expectBaseStreamCallModelFields(baseStream, 0, {
      provider: "lmstudio",
      id: canonicalKey,
    });
    expectBaseStreamCallModelFields(baseStream, 1, {
      provider: "lmstudio",
      id: canonicalKey,
    });
  });

  it("skips native model preload when provider params disable it", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: defaultBaseUrl,
              params: { preload: false },
              models: [],
            },
          },
        },
      },
      streamFn: baseStream,
    } as never);

    const events = await collectEvents(
      wrapped(
        {
          provider: "lmstudio",
          api: "openai-completions",
          id: "qwen3-8b-instruct",
        } as never,
        { messages: [] } as never,
        undefined as never,
      ),
    );

    expectSingleDoneEvent(events);
    expect(prepareLmstudioModelForInferenceMock).not.toHaveBeenCalled();
    expect(baseStream).toHaveBeenCalledTimes(1);
    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsUsageInStreaming: true,
    });
  });

  it("dedupes concurrent preload requests for the same model and context", async () => {
    let resolvePreload: (() => void) | undefined;
    prepareLmstudioModelForInferenceMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePreload = resolve;
        }),
    );
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: defaultBaseUrl,
              models: [],
            },
          },
        },
      },
      streamFn: baseStream,
    } as never);

    const first = wrapped(
      {
        provider: "lmstudio",
        api: "openai-completions",
        id: "qwen3-8b-instruct",
        contextWindow: 32768,
      } as never,
      { messages: [] } as never,
      undefined as never,
    );
    const second = wrapped(
      {
        provider: "lmstudio",
        api: "openai-completions",
        id: "qwen3-8b-instruct",
        contextWindow: 32768,
      } as never,
      { messages: [] } as never,
      undefined as never,
    );

    const firstPromise = collectEvents(first);
    const secondPromise = collectEvents(second);
    await vi.waitFor(() => {
      if (!resolvePreload) {
        throw new Error("LM Studio preload resolver not initialized");
      }
    });
    if (!resolvePreload) {
      throw new Error("LM Studio preload resolver not initialized");
    }
    resolvePreload();
    const [firstEvents, secondEvents] = await Promise.all([firstPromise, secondPromise]);

    expectSingleDoneEvent(firstEvents);
    expectSingleDoneEvent(secondEvents);
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);
  });

  it("does not start model preload for an already-aborted inference", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const controller = new AbortController();
    const abortReason = new Error("inference already cancelled");
    controller.abort(abortReason);
    const options = { signal: controller.signal };
    const stream = Promise.resolve().then(() =>
      runWrappedLmstudioStream(wrapped, { contextWindow: 32_768 }, options),
    );

    await expect(stream).rejects.toBe(abortReason);
    expect(prepareLmstudioModelForInferenceMock).not.toHaveBeenCalled();
    expect(baseStream).not.toHaveBeenCalled();
  });

  it("cancels one shared preload waiter without cancelling another inference", async () => {
    let resolvePreload: (() => void) | undefined;
    prepareLmstudioModelForInferenceMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePreload = resolve;
        }),
    );
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const controller = new AbortController();
    const first = collectEvents(
      runWrappedLmstudioStream(wrapped, { contextWindow: 32_768 }, { signal: controller.signal }),
    );
    let firstOutcome: string | undefined;
    void first.then(
      () => {
        firstOutcome = "completed";
      },
      (error: unknown) => {
        firstOutcome = error instanceof Error ? error.name : "unknown";
      },
    );
    const second = collectEvents(runWrappedLmstudioStream(wrapped, { contextWindow: 32_768 }));

    try {
      await vi.waitFor(() => expect(resolvePreload).toBeDefined());
      controller.abort(new DOMException("inference cancelled", "AbortError"));

      await vi.waitFor(() => expect(firstOutcome).toBe("AbortError"), {
        timeout: 250,
      });
      expect(baseStream).not.toHaveBeenCalled();
      expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);

      resolvePreload?.();

      expectSingleDoneEvent(await second);
      expect(baseStream).toHaveBeenCalledTimes(1);
    } finally {
      resolvePreload?.();
      await Promise.allSettled([first, second]);
    }
  });

  it("skips preload on the second attempt while the failure backoff is active", async () => {
    prepareLmstudioModelForInferenceMock.mockRejectedValue(new Error("out of memory"));
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: defaultBaseUrl,
              models: [],
            },
          },
        },
      },
      streamFn: baseStream,
    } as never);

    const firstEvents = await collectEvents(
      wrapped(
        {
          provider: "lmstudio",
          api: "openai-completions",
          id: "qwen3-8b-instruct",
        } as never,
        { messages: [] } as never,
        undefined as never,
      ),
    );
    expectSingleDoneEvent(firstEvents);
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);

    const secondEvents = await collectEvents(
      wrapped(
        {
          provider: "lmstudio",
          api: "openai-completions",
          id: "qwen3-8b-instruct",
        } as never,
        { messages: [] } as never,
        undefined as never,
      ),
    );
    expectSingleDoneEvent(secondEvents);
    // The second call must NOT retry preload because cooldown is active, but
    // the underlying stream must still run so the user gets a response.
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);
    expect(baseStream).toHaveBeenCalledTimes(2);
  });

  it("preserves all 29 agent tools while preload failure backoff remains active", async () => {
    prepareLmstudioModelForInferenceMock.mockRejectedValueOnce(new Error("out of memory"));
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const tools = Array.from({ length: 29 }, (_, index) => ({
      name: `agent_tool_${index}`,
      description: `Agent tool ${index}`,
      parameters: { type: "object" },
    }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const events = await collectEvents(
        runWrappedLmstudioStream(wrapped, {}, undefined, { tools }),
      );

      expectSingleDoneEvent(events);
      const call = (baseStream as unknown as { mock: { calls: unknown[][] } }).mock.calls[attempt];
      expect(call).toBeDefined();
      expect(requireRecord(call?.[1], "base stream context").tools).toEqual(tools);
    }

    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);
    expect(baseStream).toHaveBeenCalledTimes(2);
  });

  it("retries preload once the cooldown expires", async () => {
    prepareLmstudioModelForInferenceMock.mockRejectedValueOnce(new Error("out of memory"));
    prepareLmstudioModelForInferenceMock.mockResolvedValueOnce(undefined);
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: defaultBaseUrl,
              models: [],
            },
          },
        },
      },
      streamFn: baseStream,
    } as never);

    // Freeze Date.now at a known base so we can jump past the first backoff
    // window (5s by default) between the two preload attempts.
    const baseTime = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(baseTime);
    await collectEvents(
      wrapped(
        {
          provider: "lmstudio",
          api: "openai-completions",
          id: "qwen3-8b-instruct",
        } as never,
        { messages: [] } as never,
        undefined as never,
      ),
    );
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);

    // Move the clock past the initial 5s cooldown window so the next call is
    // allowed to retry preload.
    nowSpy.mockReturnValue(baseTime + 6_000);
    await collectEvents(
      wrapped(
        {
          provider: "lmstudio",
          api: "openai-completions",
          id: "qwen3-8b-instruct",
        } as never,
        { messages: [] } as never,
        undefined as never,
      ),
    );
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it("keeps increasing preload backoff across expired consecutive failures", async () => {
    prepareLmstudioModelForInferenceMock.mockRejectedValue(new Error("out of memory"));
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const baseTime = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseTime);

    await collectEvents(runWrappedLmstudioStream(wrapped, {}));
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(baseTime + 5_001);
    await collectEvents(runWrappedLmstudioStream(wrapped, {}));
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(baseTime + 10_001);
    await collectEvents(runWrappedLmstudioStream(wrapped, {}));
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValue(baseTime + 15_002);
    await collectEvents(runWrappedLmstudioStream(wrapped, {}));
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(3);

    nowSpy.mockReturnValue(baseTime + 30_002);
    await collectEvents(runWrappedLmstudioStream(wrapped, {}));
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(3);

    nowSpy.mockReturnValue(baseTime + 35_003);
    await collectEvents(runWrappedLmstudioStream(wrapped, {}));
    expect(prepareLmstudioModelForInferenceMock).toHaveBeenCalledTimes(4);
    expect(baseStream).toHaveBeenCalledTimes(6);
  });

  it("forces supportsUsageInStreaming compat before calling the underlying stream", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: defaultBaseUrl,
              models: [],
            },
          },
        },
      },
      streamFn: baseStream,
    } as never);

    const stream = wrapped(
      {
        provider: "lmstudio",
        api: "openai-completions",
        id: "qwen3-8b-instruct",
        compat: { supportsDeveloperRole: false },
      } as never,
      { messages: [] } as never,
      undefined as never,
    );
    const events = await collectEvents(stream);

    expectSingleDoneEvent(events);
    expect(baseStream).toHaveBeenCalledTimes(1);
    expectBaseStreamModelFields(baseStream, { provider: "lmstudio" });
    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
    });
  });

  it("marks regex tool patterns as unsupported before LM Studio inference", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);

    expectSingleDoneEvent(await collectEvents(runWrappedLmstudioStream(wrapped, {})));

    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsUsageInStreaming: true,
      unsupportedToolSchemaKeywords: ["pattern"],
    });
  });

  it("preserves and deduplicates configured unsupported tool-schema keywords", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = createWrappedLmstudioStream(baseStream);
    const originalCompat = {
      supportsDeveloperRole: false,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum", "pattern"],
    };

    expectSingleDoneEvent(
      await collectEvents(runWrappedLmstudioStream(wrapped, { compat: originalCompat })),
    );

    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum"],
    });
    expect(originalCompat).toEqual({
      supportsDeveloperRole: false,
      unsupportedToolSchemaKeywords: ["format", "pattern", "minimum", "pattern"],
    });
  });

  it("applies regex tool-schema compatibility when LM Studio preload is disabled", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: defaultBaseUrl,
              params: { preload: false },
              models: [],
            },
          },
        },
      },
      streamFn: baseStream,
    } as never);

    expectSingleDoneEvent(
      await collectEvents(
        wrapped(
          {
            provider: "lmstudio",
            api: "openai-completions",
            id: "qwen3-8b-instruct",
            compat: { unsupportedToolSchemaKeywords: ["format"] },
          } as never,
          { messages: [] } as never,
          undefined as never,
        ),
      ),
    );

    expect(prepareLmstudioModelForInferenceMock).not.toHaveBeenCalled();
    const [model] = requireMockCallArg(
      baseStream as unknown as { mock: { calls: unknown[][] } },
      "base stream",
    );
    expectRecordFields(requireRecord(requireRecord(model, "base stream model").compat, "compat"), {
      supportsUsageInStreaming: true,
      unsupportedToolSchemaKeywords: ["format", "pattern"],
    });
  });

  it("promotes standalone bracketed local-model tool text to a structured tool call", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename","wing":"personal","room":"identities"}',
      "[END_TOOL_REQUEST]",
    ].join("\n");
    const baseStream = buildEventStreamFn([
      { type: "start", partial: lmstudioAssistantMessage([]) },
      {
        type: "text_start",
        contentIndex: 0,
        partial: lmstudioAssistantMessage([{ type: "text", text: "" }]),
      },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: lmstudioAssistantMessage([{ type: "text", text: rawToolText }]),
      },
    ]);
    const wrapped = createWrappedLmstudioStream(baseStream);
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, {}, undefined, {
        tools: [
          {
            name: "mempalace_mempalace_search",
            description: "Search MemPalace",
            parameters: { type: "object", properties: {} },
          },
        ],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expect(done.message?.stopReason).toBe("toolUse");
    const toolCall = requireRecord(done.message?.content?.[0], "tool call content");
    expectRecordFields(toolCall, {
      type: "toolCall",
      name: "mempalace_mempalace_search",
      arguments: { query: "codename", wing: "personal", room: "identities" },
    });
    expect(String(toolCall.id)).toMatch(/^call_[a-f0-9]{24}$/);
  });

  it("promotes standalone Harmony local-model tool text to a structured tool call", async () => {
    const rawToolText =
      'commentary to=read code {"path":"/path/to/file","line_start":1,"line_end":400}';
    const baseStream = buildEventStreamFn([
      { type: "start", partial: lmstudioAssistantMessage([]) },
      {
        type: "text_start",
        contentIndex: 0,
        partial: lmstudioAssistantMessage([{ type: "text", text: "" }]),
      },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: lmstudioAssistantMessage([{ type: "text", text: rawToolText }]),
      },
    ]);
    const wrapped = createWrappedLmstudioStream(baseStream);
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, {}, undefined, {
        tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.find((event) => event.type === "done") as {
      message?: { content?: Array<Record<string, unknown>>; stopReason?: string };
      reason?: string;
    };
    expect(done.reason).toBe("toolUse");
    expectRecordFields(requireRecord(done.message?.content?.[0], "tool call content"), {
      type: "toolCall",
      name: "read",
      arguments: { path: "/path/to/file", line_start: 1, line_end: 400 },
    });
  });

  it("passes through bracketed text when the tool is not registered", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename"}',
      "[/mempalace_mempalace_search]",
    ].join("\n");
    const baseStream = buildEventStreamFn([
      { type: "start", partial: lmstudioAssistantMessage([]) },
      {
        type: "text_start",
        contentIndex: 0,
        partial: lmstudioAssistantMessage([{ type: "text", text: "" }]),
      },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: lmstudioAssistantMessage([{ type: "text", text: rawToolText }]),
      },
    ]);
    const wrapped = createWrappedLmstudioStream(baseStream);
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, {}, undefined, {
        tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expectRecordFields(
      requireRecord(
        events.find((event) => event.type === "text_delta"),
        "text delta",
      ),
      {
        delta: rawToolText,
      },
    );
  });

  it("rewrites reasoning_effort to the disabled effort when thinking is off", async () => {
    const payload: Record<string, unknown> = {
      model: "qwen3-8b-instruct",
      reasoning_effort: "high",
    };
    const baseStream = buildPayloadStreamFn(payload);
    const wrapped = createWrappedLmstudioStream(baseStream, { thinkingLevel: "off" });
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, { compat: BINARY_REASONING_COMPAT }),
    );

    expectSingleDoneEvent(events);
    expect(payload.reasoning_effort).toBe("none");
  });

  it("drops reasoning_effort on thinking off when the model has no disabled effort", async () => {
    const payload: Record<string, unknown> = {
      model: "qwen3-8b-instruct",
      reasoning_effort: "high",
    };
    const baseStream = buildPayloadStreamFn(payload);
    const wrapped = createWrappedLmstudioStream(baseStream, { thinkingLevel: "off" });
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, {
        compat: {
          supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
          reasoningEffortMap: { adaptive: "xhigh", max: "xhigh" },
        },
      }),
    );

    expectSingleDoneEvent(events);
    expect("reasoning_effort" in payload).toBe(false);
  });

  it("keeps reasoning_effort untouched for enabled thinking levels", async () => {
    const payload: Record<string, unknown> = {
      model: "qwen3-8b-instruct",
      reasoning_effort: "high",
    };
    const baseStream = buildPayloadStreamFn(payload);
    const wrapped = createWrappedLmstudioStream(baseStream, { thinkingLevel: "high" });
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, { compat: BINARY_REASONING_COMPAT }),
    );

    expectSingleDoneEvent(events);
    expect(payload.reasoning_effort).toBe("high");
  });

  it("keeps reasoning_effort untouched without a thinking level", async () => {
    const payload: Record<string, unknown> = {
      model: "qwen3-8b-instruct",
      reasoning_effort: "high",
    };
    const baseStream = buildPayloadStreamFn(payload);
    const wrapped = createWrappedLmstudioStream(baseStream);
    const events = await collectEvents(
      runWrappedLmstudioStream(wrapped, { compat: BINARY_REASONING_COMPAT }),
    );

    expectSingleDoneEvent(events);
    expect(payload.reasoning_effort).toBe("high");
  });
});
