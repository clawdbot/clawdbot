import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLmstudioPreloadCooldownForTest,
  wrapLmstudioInferencePreload,
} from "./stream.js";

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

type StreamEvent = { type: string };

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

describe("lmstudio stream wrapper", () => {
  beforeEach(() => {
    __resetLmstudioPreloadCooldownForTest();
  });

  afterEach(() => {
    ensureLmstudioModelLoadedMock.mockReset();
    resolveLmstudioProviderHeadersMock.mockReset();
    resolveLmstudioRuntimeApiKeyMock.mockReset();
    resolveLmstudioProviderHeadersMock.mockResolvedValue(undefined);
    resolveLmstudioRuntimeApiKeyMock.mockResolvedValue(undefined);
    __resetLmstudioPreloadCooldownForTest();
  });

  it("preloads LM Studio model before inference using model context window", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://lmstudio.internal:1234/v1",
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
        id: "lmstudio/qwen3-8b-instruct",
        contextWindow: 131072,
      } as never,
      { messages: [] } as never,
      { apiKey: "lmstudio-token" } as never,
    );
    const events = await collectEvents(stream);

    expect(events).toEqual([expect.objectContaining({ type: "done" })]);
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://lmstudio.internal:1234/v1",
        modelKey: "qwen3-8b-instruct",
        requestedContextLength: 131072,
        apiKey: "lmstudio-token",
        ssrfPolicy: { allowedHostnames: ["lmstudio.internal"] },
      }),
    );
  });

  it("prefers model contextTokens over contextWindow for preload requests", async () => {
    const baseStream = buildDoneStreamFn();
    const wrapped = wrapLmstudioInferencePreload({
      provider: "lmstudio",
      modelId: "qwen3-8b-instruct",
      config: {
        models: {
          providers: {
            lmstudio: {
              baseUrl: "http://lmstudio.internal:1234/v1",
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
        id: "lmstudio/qwen3-8b-instruct",
        contextWindow: 131072,
        contextTokens: 64000,
      } as never,
      { messages: [] } as never,
      { apiKey: "lmstudio-token" } as never,
    );
    const events = await collectEvents(stream);

    expect(events).toEqual([expect.objectContaining({ type: "done" })]);
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledTimes(1);
    expect(ensureLmstudioModelLoadedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://lmstudio.internal:1234/v1",
        modelKey: "qwen3-8b-instruct",
        requestedContextLength: 64000,
        apiKey: "lmstudio-token",
        ssrfPolicy: { allowedHostnames: ["lmstudio.internal"] },
      }),
    );
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
    expect(events).toEqual([expect.objectContaining({ type: "done" })]);
    expect(baseStream).toHaveBeenCalledTimes(1);
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

    expect(firstEvents).toEqual([expect.objectContaining({ type: "done" })]);
    expect(secondEvents).toEqual([expect.objectContaining({ type: "done" })]);
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
    expect(firstEvents).toEqual([expect.objectContaining({ type: "done" })]);
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
    expect(secondEvents).toEqual([expect.objectContaining({ type: "done" })]);
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

    expect(events).toEqual([expect.objectContaining({ type: "done" })]);
    expect(baseStream).toHaveBeenCalledTimes(1);
    expect(baseStream).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "lmstudio",
        compat: expect.objectContaining({
          supportsDeveloperRole: false,
          supportsUsageInStreaming: true,
        }),
      }),
      expect.anything(),
      undefined,
    );
  });
});
