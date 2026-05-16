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
  const createModelLoadFetchMock = (params?: {
    loadedContextLength?: number;
    maxContextLength?: number;
  }) =>
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                type: "llm",
                key: "qwen3-8b-instruct",
                max_context_length: params?.maxContextLength,
                loaded_instances: params?.loadedContextLength
                  ? [{ id: "inst-1", config: { context_length: params.loadedContextLength } }]
                  : [],
              },
            ],
          }),
        };
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return {
          ok: true,
          json: async () => ({ status: "loaded" }),
          requestInit: init,
        };
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

  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
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
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
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
    }));

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

  it("reports malformed model list JSON with an owned error", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }));

    const result = await fetchLmstudioModels({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: asFetch(fetchMock),
    });

    expect(result.reachable).toBe(false);
    expect((result.error as Error).message).toBe("LM Studio model list: malformed JSON response");
  });

  it("reports wrong-shaped model list payloads with owned errors", async () => {
    for (const payload of [[], { models: {} }, { models: [null] }]) {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
      }));

      const result = await fetchLmstudioModels({
        baseUrl: "http://localhost:1234/v1",
        fetchImpl: asFetch(fetchMock),
      });

      expect(result.reachable).toBe(false);
      expect((result.error as Error).message).toBe("LM Studio model list: malformed JSON response");
    }
  });

  it("skips model load when already loaded", async () => {
    const fetchMock = createModelLoadFetchMock({ loadedContextLength: 64000 });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
      }),
    ).resolves.toBeUndefined();

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
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectLoadContextLength(fetchMock, 8192);
  });

  it("reports malformed model load JSON with an owned error", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
          }),
        };
      }
      if (String(url).endsWith("/api/v1/models/load")) {
        return {
          ok: true,
          json: async () => {
            throw new SyntaxError("bad json");
          },
        };
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    vi.stubGlobal("fetch", asFetch(fetchMock));

    await expect(
      ensureLmstudioModelLoaded({
        baseUrl: "http://localhost:1234/v1",
        modelKey: "qwen3-8b-instruct",
      }),
    ).rejects.toThrow("LM Studio model load returned malformed JSON");
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
    ).resolves.toBeUndefined();

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
    ).resolves.toBeUndefined();

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
    ).resolves.toBeUndefined();

    expectLoadContextLength(fetchMock, 8192);
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
