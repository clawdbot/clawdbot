import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetLmstudioPreloadCooldownForTest, wrapLmstudioInferencePreload } from "./stream.js";

const ensureLmstudioModelLoadedMock = vi.hoisted(() => vi.fn());
const resolveLmstudioProviderHeadersMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);
const resolveLmstudioRuntimeApiKeyMock = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => undefined),
);

vi.mock("./models.fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models.fetch.js")>();
  return {
    ...actual,
    ensureLmstudioModelLoaded: (params: unknown) => ensureLmstudioModelLoadedMock(params),
  };
});

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    resolveLmstudioProviderHeaders: (params: unknown) => resolveLmstudioProviderHeadersMock(params),
    resolveLmstudioRuntimeApiKey: (params: unknown) => resolveLmstudioRuntimeApiKeyMock(params),
  };
});

afterAll(() => {
  vi.doUnmock("./models.fetch.js");
  vi.doUnmock("./runtime.js");
  vi.resetModules();
});

type StreamEvent = { type: string } & Record<string, unknown>;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
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
  const [params] = requireMockCallArg(ensureLmstudioModelLoadedMock, "ensureLmstudioModelLoaded");
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
  expect(call[1]).toBeDefined();
  expect(call[2]).toBeUndefined();
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
      stream.push({ type: "done", reason: "stop", message: {} as never });
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
  params?: { baseUrl?: string },
): StreamFn {
  return wrapLmstudioInferencePreload({
    provider: "lmstudio",
    modelId: "qwen3-8b-instruct",
    config: {
      models: {
        providers: {
          lmstudio: {
            baseUrl: params?.baseUrl ?? "http://localhost:1234",
            models: [],
          },
        },
      },
    },
    streamFn: baseStream,
  } as never);
}

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
    __resetLmstudioPreloadCooldownForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ensureLmstudioModelLoadedMock.mockReset();
    resolveLmstudioProviderHeadersMock.mockReset();
    resolveLmstudioRuntimeApiKeyMock.mockReset();
    resolveLmstudioProviderHeadersMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue(undefined);
    __resetLmstudioPreloadCooldownForTest();
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
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
    expectEnsureLoadedFields({
      baseUrl: "http://lmstudio.internal:1234/v1",
      modelKey: "qwen3-8b-instruct",
      requestedContextLength: 131072,
      apiKey: "lmstudio-token",
      ssrfPolicy: { allowedHostnames: ["lmstudio.internal"] },
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
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
    expectEnsureLoadedFields({
      baseUrl: "http://lmstudio.internal:1234/v1",
      modelKey: "qwen3-8b-instruct",
      requestedContextLength: 64000,
      apiKey: "lmstudio-token",
      ssrfPolicy: { allowedHostnames: ["lmstudio.internal"] },
    });
  });

  it("continues inference when preload fails", async () => {
    ensureLmstudioModelLoadedMock.mockRejectedValueOnce(new Error("load failed"));
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
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

  it("skips native model preload when provider params disable it", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
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
    expect(ensureLmstudioModelLoadedMock).not.toHaveBeenCalled();
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
    ensureLmstudioModelLoadedMock.mockImplementationOnce(
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
              baseUrl: "http://localhost:1234",
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
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
  });

  it("skips preload on the second attempt while the failure backoff is active", async () => {
    ensureLmstudioModelLoadedMock.mockRejectedValue(new Error("out of memory"));
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
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
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);

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
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
    expect(baseStream).toHaveBeenCalledTimes(2);
  });

  it("retries preload once the cooldown expires", async () => {
    ensureLmstudioModelLoadedMock.mockRejectedValueOnce(new Error("out of memory"));
    ensureLmstudioModelLoadedMock.mockResolvedValueOnce(undefined);
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://localhost:1234",
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
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);

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
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
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
              baseUrl: "http://localhost:1234",
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

  it("promotes standalone bracketed local-model tool text to a structured tool call", async () => {
    const rawToolText = [
      "[mempalace_mempalace_search]",
      '{"query":"codename","wing":"personal","room":"identities"}',
      "[END_TOOL_REQUEST]",
    ].join("\n");
    const baseStream = buildEventStreamFn([
      { type: "start", partial: { content: [] } },
      { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] } },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
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
      { type: "start", partial: { content: [] } },
      { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] } },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
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
      { type: "start", partial: { content: [] } },
      { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] } },
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "text_end", contentIndex: 0, content: rawToolText },
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: rawToolText }],
          stopReason: "stop",
        },
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
});
