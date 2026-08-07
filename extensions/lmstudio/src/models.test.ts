// Lmstudio tests cover models plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH } from "./defaults.js";
import {
  discoverLmstudioModels,
  ensureLmstudioModelLoaded,
  fetchLmstudioModels,
} from "./models.fetch.js";
import {
  mapLmstudioWireEntry,
  normalizeLmstudioConfiguredCatalogEntry,
  normalizeLmstudioProviderConfig,
  resolveLmstudioInferenceBase,
  resolveLmstudioReasoningCompat,
  resolveLmstudioReasoningCapability,
  resolveLmstudioServerBase,
} from "./models.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function malformedJsonResponse(): Response {
  return new Response("{ nope", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("lmstudio-models", () => {
  const asFetch = (mock: unknown) => mock as typeof fetch;
  const parseJsonRequestBody = (init: RequestInit | undefined): unknown => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected request body to be a JSON string");
    }
    return JSON.parse(init.body) as unknown;
  };
  const cancelTrackedResponse = (
    text: string,
    init: ResponseInit,
  ): {
    response: Response;
    wasCanceled: () => boolean;
  } => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
      },
      cancel() {
        canceled = true;
      },
    });
    return {
      response: new Response(stream, init),
      wasCanceled: () => canceled,
    };
  };
  const createModelLoadFetchMock = (params?: {
    key?: string;
    variants?: unknown;
    selectedVariant?: unknown;
    loadedContextLength?: number;
    maxContextLength?: number;
  }) =>
    vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const key = params?.key ?? "qwen3-8b-instruct";
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [
            {
              type: "llm",
              key,
              max_context_length: params?.maxContextLength,
              variants: params?.variants,
              selected_variant: params?.selectedVariant,
              loaded_instances: params?.loadedContextLength
                ? [{ id: "inst-1", config: { context_length: params.loadedContextLength } }]
                : [],
            },
          ],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return jsonResponse({ status: "loaded" });
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
  const findModelLoadCall = (fetchMock: ReturnType<typeof createModelLoadFetchMock>) =>
    fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/models/load"));
  const expectLoadContextLength = (
    fetchMock: ReturnType<typeof createModelLoadFetchMock>,
    contextLength: number,
  ) => {
    const loadCall = findModelLoadCall(fetchMock);
    if (!loadCall) {
      throw new Error("expected LM Studio model load request");
    }
    const loadInit = loadCall[1] as RequestInit;
    const loadBody = parseJsonRequestBody(loadInit) as { context_length: number };
    expect(loadBody.context_length).toBe(contextLength);
  };
  const expectLoadModelKey = (
    fetchMock: ReturnType<typeof createModelLoadFetchMock>,
    modelKey: string,
  ) => {
    const loadCall = findModelLoadCall(fetchMock);
    if (!loadCall) {
      throw new Error("expected LM Studio model load request");
    }
    const loadInit = loadCall[1] as RequestInit;
    const loadBody = parseJsonRequestBody(loadInit) as { model: string };
    expect(loadBody.model).toBe(modelKey);
  };

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes LM Studio base URLs", () => {
    expect(resolveLmstudioServerBase()).toBe("http://localhost:1234");
    expect(resolveLmstudioInferenceBase()).toBe("http://localhost:1234/v1");
    expect(resolveLmstudioServerBase("http://localhost:1234/api/v1")).toBe("http://localhost:1234");
    expect(resolveLmstudioInferenceBase("http://localhost:1234/api/v1")).toBe(
      "http://localhost:1234/v1",
    );
    expect(resolveLmstudioServerBase("localhost:1234/api/v1")).toBe("http://localhost:1234");
    expect(resolveLmstudioInferenceBase("localhost:1234/api/v1")).toBe("http://localhost:1234/v1");
  });

  it("marks configured LM Studio endpoints as trusted private-network model targets", () => {
    expect(
      normalizeLmstudioProviderConfig({
        baseUrl: "http://192.168.1.10:1234",
        models: [],
      }),
    ).toEqual({
      baseUrl: "http://192.168.1.10:1234/v1",
      request: { allowPrivateNetwork: true },
      models: [],
    });

    expect(
      normalizeLmstudioProviderConfig({
        baseUrl: "http://gpu-box.local:1234/v1",
        request: {
          allowPrivateNetwork: false,
          headers: { "X-Proxy-Auth": "token" },
        },
        models: [],
      }),
    ).toEqual({
      baseUrl: "http://gpu-box.local:1234/v1",
      request: {
        allowPrivateNetwork: false,
        headers: { "X-Proxy-Auth": "token" },
      },
      models: [],
    });
  });

  it("drops malformed configured catalog token metadata", () => {
    expect(
      normalizeLmstudioConfiguredCatalogEntry({
        id: "bad-window",
        contextWindow: Number.POSITIVE_INFINITY,
        contextTokens: 4096.5,
      }),
    ).toMatchObject({
      id: "bad-window",
      contextWindow: undefined,
      contextTokens: undefined,
    });

    expect(
      normalizeLmstudioConfiguredCatalogEntry({
        id: "bad-tokens",
        contextWindow: -1,
        contextTokens: 0,
      }),
    ).toMatchObject({
      id: "bad-tokens",
      contextWindow: undefined,
      contextTokens: undefined,
    });
  });

  it("drops malformed discovered context metadata", () => {
    const model = mapLmstudioWireEntry({
      type: "llm",
      key: "bad-context",
      max_context_length: 32768.5,
      loaded_instances: [{ id: "loaded", config: { context_length: Number.POSITIVE_INFINITY } }],
    });

    expect(model).toMatchObject({
      id: "bad-context",
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
      loaded: false,
    });
  });

  it("resolves reasoning capability for supported and unsupported options", () => {
    expect(resolveLmstudioReasoningCapability({ capabilities: undefined })).toBe(false);
    expect(
      resolveLmstudioReasoningCapability({
        capabilities: {
          reasoning: {
            allowed_options: ["low", "medium", "high"],
            default: "low",
          },
        },
      }),
    ).toBe(true);
    expect(
      resolveLmstudioReasoningCapability({
        capabilities: {
          reasoning: {
            allowed_options: ["off"],
            default: "off",
          },
        },
      }),
    ).toBe(false);
  });

  it("maps LM Studio binary reasoning options into OpenAI-compatible effort compat", () => {
    expect(
      resolveLmstudioReasoningCompat({
        capabilities: {
          reasoning: {
            allowed_options: ["off", "on"],
            default: "on",
          },
        },
      }),
    ).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
      reasoningEffortMap: {
        off: "none",
        none: "none",
        adaptive: "xhigh",
        max: "xhigh",
      },
    });

    expect(
      resolveLmstudioReasoningCompat({
        capabilities: {
          reasoning: {
            allowed_options: ["low", "medium", "high"],
            default: "low",
          },
        },
      }),
    ).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
      reasoningEffortMap: {
        adaptive: "high",
        max: "high",
      },
    });

    expect(
      resolveLmstudioReasoningCompat({
        capabilities: {
          reasoning: {
            allowed_options: ["off"],
            default: "off",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("discovers llm models and maps metadata", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({
        models: [
          {
            type: "llm",
            key: "qwen3-8b-instruct",
            display_name: "Qwen3 8B",
            max_context_length: 262144,
            format: "mlx",
            capabilities: {
              vision: true,
              trained_for_tool_use: true,
              reasoning: {
                allowed_options: ["off", "on"],
                default: "on",
              },
            },
            loaded_instances: [{ id: "inst-1", config: { context_length: 64000 } }],
          },
          {
            type: "llm",
            key: "deepseek-r1",
          },
          {
            type: "embedding",
            key: "text-embedding-nomic-embed-text-v1.5",
          },
          {
            type: "llm",
            key: "   ",
          },
        ],
      }),
    );

    const models = await discoverLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      apiKey: "lm-token",
      quiet: false,
      fetchImpl: asFetch(fetchMock),
    });

    const modelsRequest = fetchMock.mock.calls.find(
      ([url]) => url === "http://localhost:1234/api/v1/models",
    );
    const modelsRequestOptions = modelsRequest?.[1] as
      | { headers?: Record<string, string>; signal?: unknown }
      | undefined;
    expect(modelsRequestOptions?.headers).toEqual({
      Authorization: "Bearer lm-token",
    });
    expect(modelsRequestOptions?.signal).toBeInstanceOf(AbortSignal);

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: "qwen3-8b-instruct",
      name: "Qwen3 8B (MLX, vision, tool-use, loaded)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
        reasoningEffortMap: {
          off: "none",
          none: "none",
          adaptive: "xhigh",
          max: "xhigh",
        },
      },
      contextWindow: 262144,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    });
    expect(models[1]).toEqual({
      id: "deepseek-r1",
      name: "deepseek-r1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsUsageInStreaming: true },
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      contextTokens: LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    });
  });

  it("cancels the response body after a non-ok model discovery response", async () => {
    const tracked = cancelTrackedResponse("unavailable", { status: 503 });
    const fetchMock = vi.fn(async () => tracked.response);

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: asFetch(fetchMock),
    });

    expect(result).toEqual({
      reachable: true,
      status: 503,
      models: [],
    });
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("cancels guarded non-ok discovery bodies before releasing the dispatcher", async () => {
    const tracked = cancelTrackedResponse("unavailable", { status: 503 });
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock.mockResolvedValue({ response: tracked.response, release });

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      ssrfPolicy: {},
    });

    expect(result).toMatchObject({ reachable: true, status: 503, models: [] });
    expect(tracked.wasCanceled()).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports malformed model list JSON with an owned error", async () => {
    const fetchMock = vi.fn(async () => malformedJsonResponse());

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: asFetch(fetchMock),
    });

    expect(result.reachable).toBe(false);
    expect((result.error as Error).message).toBe("LM Studio model list: malformed JSON response");
  });

  it("reports wrong-shaped model list payloads with owned errors", async () => {
    for (const payload of [[], { models: {} }, { models: [null] }]) {
      const fetchMock = vi.fn(async () => jsonResponse(payload));

      const result = await fetchLmstudioModels({
        baseUrl: "http://localhost:1234/v1",
        fetchImpl: asFetch(fetchMock),
      });

      expect(result.reachable).toBe(false);
      expect((result.error as Error).message).toBe("LM Studio model list: malformed JSON response");
    }
  });

  it("caps oversized direct fetch timeouts before discovering models", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({ models: [] }),
    );

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      fetchImpl: asFetch(fetchMock),
    });

    expect(result.reachable).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutController.signal);
  });

  it("caps oversized guarded-fetch timeouts before discovering models", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ models: [] }), { status: 200 }),
      release: vi.fn(async () => undefined),
    });

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      timeoutMs: Number.MAX_SAFE_INTEGER,
      ssrfPolicy: {},
    });

    expect(result.reachable).toBe(true);
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
  });

  it("skips model load when already loaded", async () => {
    const fetchMock = createModelLoadFetchMock({ loadedContextLength: 64000 });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
      }),
    ).resolves.toBe("qwen3-8b-instruct");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls).not.toContain("http://localhost:1234/api/v1/models/load");
  });

  it("reloads model when requested context length exceeds the loaded window", async () => {
    const fetchMock = createModelLoadFetchMock({
      loadedContextLength: 4096,
      maxContextLength: 32768,
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
        requestedContextLength: 8192,
      }),
    ).resolves.toBe("qwen3-8b-instruct");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLoadContextLength(fetchMock, 8192);
  });

  it("loads the canonical model key when the requested key is an advertised variant", async () => {
    const canonicalKey = "gemma-4-e4b-it-ultra-uncensored-heretic";
    const variantKey = `${canonicalKey}@q4_k_m`;
    const fetchMock = createModelLoadFetchMock({
      key: canonicalKey,
      variants: [variantKey],
      selectedVariant: variantKey,
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: variantKey,
      }),
    ).resolves.toBe(canonicalKey);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLoadModelKey(fetchMock, canonicalKey);
  });

  it("keeps the canonical model key on load failures after variant discovery", async () => {
    const canonicalKey = "gemma-4-e4b-it-ultra-uncensored-heretic";
    const variantKey = `${canonicalKey}@q4_k_m`;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [
            {
              type: "llm",
              key: canonicalKey,
              variants: [variantKey],
              selected_variant: variantKey,
              loaded_instances: [],
            },
          ],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return new Response("load failed", { status: 503 });
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    const error = await ensureLmstudioModelLoaded({
      baseUrl: "http://localhost:1234/v1",
      modelKey: variantKey,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ resolvedModelKey: canonicalKey });
  });

  it("preserves a suffixed key when LM Studio advertises it as the model key", async () => {
    const suffixedKey = "local/special-model@q4_k_m";
    const fetchMock = createModelLoadFetchMock({
      key: suffixedKey,
      variants: ["local/special-model@q8_0"],
      selectedVariant: "local/special-model@q8_0",
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: suffixedKey,
      }),
    ).resolves.toBe(suffixedKey);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLoadModelKey(fetchMock, suffixedKey);
  });

  it("reports malformed model load JSON with an owned error", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return malformedJsonResponse();
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
      }),
    ).rejects.toThrow("LM Studio model load: malformed JSON response");
  });

  it("bounds oversized model load success bodies", async () => {
    // A misbehaving server may stream an unbounded success JSON body; the load
    // path must stop reading at the byte cap instead of buffering it all.
    let canceled = false;
    let bytesEmitted = 0;
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Far exceeds the 16 MiB provider JSON cap if read to completion.
        if (bytesEmitted >= 32 * 1024 * 1024) {
          controller.close();
          return;
        }
        bytesEmitted += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return new Response(oversizedStream, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    const error = await ensureLmstudioModelLoaded({
      baseUrl: "http://localhost:1234/v1",
      modelKey: "qwen3-8b-instruct",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/JSON response exceeds \d+ bytes/);
    expect(canceled).toBe(true);
    expect(bytesEmitted).toBeLessThan(32 * 1024 * 1024);
  });

  it("bounds model load error bodies", async () => {
    const body = `${"lmstudio load unavailable ".repeat(512)}tail`;
    const tracked = cancelTrackedResponse(body, { status: 503 });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return jsonResponse({
          models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
        });
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return tracked.response;
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    const error = await ensureLmstudioModelLoaded({
      baseUrl: "http://localhost:1234/v1",
      modelKey: "qwen3-8b-instruct",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /LM Studio model load failed \(503\): lmstudio load unavailable/,
    );
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("reloads model to the clamped default target when already loaded below the default window", async () => {
    const fetchMock = createModelLoadFetchMock({
      loadedContextLength: 4096,
      maxContextLength: 32768,
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
      }),
    ).resolves.toBe("qwen3-8b-instruct");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLoadContextLength(fetchMock, 32768);
  });

  it("loads model with clamped context length and merged headers", async () => {
    const fetchMock = createModelLoadFetchMock({ maxContextLength: 32768 });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        apiKey: "lm-token",
        headers: {
          "X-Proxy-Auth": "required",
          Authorization: "Bearer override",
        },
        modelKey: " qwen3-8b-instruct ",
      }),
    ).resolves.toBe("qwen3-8b-instruct");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const loadCall = findModelLoadCall(fetchMock);
    if (!loadCall) {
      throw new Error("expected LM Studio model load request");
    }
    const loadInit = loadCall[1] as RequestInit;
    const { signal, ...stableLoadInit } = loadInit;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(stableLoadInit).toEqual({
      method: "POST",
      headers: {
        "X-Proxy-Auth": "required",
        Authorization: "Bearer lm-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-8b-instruct",
        context_length: 32768,
      }),
    });
    const loadBody = parseJsonRequestBody(loadInit) as { context_length: number };
    expect(loadBody.context_length).not.toBe(LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH);
  });

  it("uses requested context length when provided for model load", async () => {
    const fetchMock = createModelLoadFetchMock({ maxContextLength: 32768 });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
        requestedContextLength: 8192,
      }),
    ).resolves.toBe("qwen3-8b-instruct");

    expectLoadContextLength(fetchMock, 8192);
  });

  it("omits malformed context lengths before loading models", async () => {
    const fetchMock = createModelLoadFetchMock({
      loadedContextLength: 4096.5,
      maxContextLength: 32768.5,
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
        requestedContextLength: 8192.5,
      }),
    ).resolves.toBe("qwen3-8b-instruct");

    expectLoadContextLength(fetchMock, LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH);
  });

  it("throws when model discovery fails", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
    }));
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
      }),
    ).rejects.toThrow("LM Studio model discovery failed (401)");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
