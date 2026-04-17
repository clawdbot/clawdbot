import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import {
  normalizePluginDiscoveryResult,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { loadBundledPluginPublicSurfaceSync } from "../test-utils/bundled-plugin-public-surface.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { OLLAMA_LOCAL_AUTH_MARKER } from "./model-auth-markers.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Ollama provider", () => {
  const createAgentDir = () => mkdtempSync(join(tmpdir(), "openclaw-test-"));

  const enableDiscoveryEnv = () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
  };

  const fetchCallUrls = (fetchMock: ReturnType<typeof vi.fn>): string[] =>
    fetchMock.mock.calls.map(([input]) => String(input));

  const expectDiscoveryCallCounts = (
    fetchMock: ReturnType<typeof vi.fn>,
    params: { tags: number; show: number },
  ) => {
    const urls = fetchCallUrls(fetchMock);
    expect(urls.filter((url) => url.endsWith("/api/tags"))).toHaveLength(params.tags);
    expect(urls.filter((url) => url.endsWith("/api/show"))).toHaveLength(params.show);
  };

  async function withOllamaApiKey<T>(run: () => Promise<T>): Promise<T> {
    process.env.OLLAMA_API_KEY = "test-key"; // pragma: allowlist secret
    try {
      return await run();
    } finally {
      delete process.env.OLLAMA_API_KEY;
    }
  }

  let ollamaCatalogProvider: ProviderPlugin | undefined;

  function loadOllamaCatalogProvider(): ProviderPlugin | undefined {
    if (ollamaCatalogProvider) {
      return ollamaCatalogProvider;
    }
    const surface = loadBundledPluginPublicSurfaceSync<{
      default?: ProviderPlugin;
      ollamaProviderDiscovery?: ProviderPlugin;
    }>({
      pluginId: "ollama",
      artifactBasename: "provider-discovery.js",
    });
    ollamaCatalogProvider = surface.default ?? surface.ollamaProviderDiscovery;
    return ollamaCatalogProvider;
  }

  async function runOllamaCatalog(params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }): Promise<ProviderConfig | undefined> {
    const provider = loadOllamaCatalogProvider();
    if (!provider) {
      return undefined;
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VITEST: "1",
      NODE_ENV: "test",
      ...params.env,
    };
    const result = await runProviderCatalog({
      provider,
      config: params.config ?? {},
      agentDir: createAgentDir(),
      env,
      resolveProviderApiKey: () => ({
        apiKey: env.OLLAMA_API_KEY?.trim() ? env.OLLAMA_API_KEY : undefined,
      }),
      resolveProviderAuth: () => ({
        apiKey: env.OLLAMA_API_KEY?.trim() ? env.OLLAMA_API_KEY : undefined,
        mode: env.OLLAMA_API_KEY?.trim() ? "api_key" : "none",
        source: env.OLLAMA_API_KEY?.trim() ? "env" : "none",
      }),
    });
    return normalizePluginDiscoveryResult({ provider, result }).ollama as
      | ProviderConfig
      | undefined;
  }

  async function withoutAmbientOllamaEnv<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    try {
      return await run();
    } finally {
      if (previous === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = previous;
      }
    }
  }

  const createTagModel = (name: string) => ({ name, modified_at: "", size: 1, digest: "" });

  const tagsResponse = (names: string[]) => ({
    ok: true,
    json: async () => ({ models: names.map((name) => createTagModel(name)) }),
  });

  const notFoundJsonResponse = () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  });

  it("should not include ollama when no API key is configured", async () => {
    const provider = await runOllamaCatalog({
      env: { OLLAMA_API_KEY: undefined },
    });

    expect(provider).toBeUndefined();
  });

  it("should use native ollama api type", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return tagsResponse([]);
      }
      return notFoundJsonResponse();
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

    await withOllamaApiKey(async () => {
      const provider = await runOllamaCatalog({});

      expect(provider).toBeDefined();
      expect(provider?.apiKey).toBe("OLLAMA_API_KEY");
      expect(provider?.api).toBe("ollama");
      expect(provider?.baseUrl).toBe("http://127.0.0.1:11434");
      expectDiscoveryCallCounts(fetchMock, { tags: 1, show: 0 });
    });
  });

  it("should preserve explicit ollama baseUrl on implicit provider injection", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return tagsResponse([]);
      }
      return notFoundJsonResponse();
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

    await withOllamaApiKey(async () => {
      const provider = await runOllamaCatalog({
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://192.168.20.14:11434/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
        env: { OLLAMA_API_KEY: "test-key" },
      });

      expect(fetchCallUrls(fetchMock).filter((url) => url.endsWith("/api/tags"))).toHaveLength(1);

      // Native API strips /v1 suffix via resolveOllamaApiBase()
      expect(provider?.baseUrl).toBe("http://192.168.20.14:11434");
    });
  });

  it("discovers per-model context windows from /api/show", async () => {
    enableDiscoveryEnv();
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return tagsResponse(["qwen3:32b", "llama3.3:70b"]);
      }
      if (url.endsWith("/api/show")) {
        const rawBody = init?.body;
        const bodyText = typeof rawBody === "string" ? rawBody : "{}";
        const parsed = JSON.parse(bodyText) as { name?: string };
        if (parsed.name === "qwen3:32b") {
          return {
            ok: true,
            json: async () => ({ model_info: { "qwen3.context_length": 131072 } }),
          };
        }
        if (parsed.name === "llama3.3:70b") {
          return {
            ok: true,
            json: async () => ({ model_info: { "llama.context_length": 65536 } }),
          };
        }
      }
      return notFoundJsonResponse();
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

    const provider = await runOllamaCatalog({
      env: { OLLAMA_API_KEY: "test-key", VITEST: "", NODE_ENV: "development" },
    });
    const models = provider?.models ?? [];
    const qwen = models.find((model) => model.id === "qwen3:32b");
    const llama = models.find((model) => model.id === "llama3.3:70b");
    expect(qwen?.contextWindow).toBe(131072);
    expect(llama?.contextWindow).toBe(65536);
    expectDiscoveryCallCounts(fetchMock, { tags: 1, show: 2 });
  });

  it("auto-registers ollama provider when models are discovered locally", async () => {
    await withoutAmbientOllamaEnv(async () => {
      enableDiscoveryEnv();
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return tagsResponse(["deepseek-r1:latest", "llama3.3:latest"]);
        }
        if (url.endsWith("/api/show")) {
          return {
            ok: true,
            json: async () => ({ model_info: {} }),
          };
        }
        return notFoundJsonResponse();
      });
      vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

      const provider = await runOllamaCatalog({
        env: { VITEST: "", NODE_ENV: "development" },
      });

      expect(provider?.apiKey).toBe(OLLAMA_LOCAL_AUTH_MARKER);
      expect(provider?.api).toBe("ollama");
      expect(provider?.baseUrl).toBe("http://127.0.0.1:11434");
      expect(provider?.models).toHaveLength(2);
      expect(provider?.models?.[0]?.id).toBe("deepseek-r1:latest");
      expect(provider?.models?.[0]?.reasoning).toBe(true);
      expect(provider?.models?.[1]?.reasoning).toBe(false);
      expectDiscoveryCallCounts(fetchMock, { tags: 1, show: 2 });
    });
  });

  it("does not warn when Ollama is unreachable and not explicitly configured", async () => {
    await withoutAmbientOllamaEnv(async () => {
      enableDiscoveryEnv();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
      vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

      const provider = await runOllamaCatalog({
        env: { VITEST: "", NODE_ENV: "development" },
      });

      expect(provider).toBeUndefined();
      expect(
        warnSpy.mock.calls.filter(([message]) => String(message).includes("Ollama")),
      ).toHaveLength(0);
      warnSpy.mockRestore();
    });
  });

  it("warns when Ollama is unreachable and explicitly configured", async () => {
    await withoutAmbientOllamaEnv(async () => {
      enableDiscoveryEnv();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
      vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

      await runOllamaCatalog({
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://127.0.0.1:11435/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
        env: { VITEST: "", NODE_ENV: "development" },
      });

      expect(
        warnSpy.mock.calls.filter(([message]) => String(message).includes("Ollama")).length,
      ).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });
  });

  it("falls back to default context window when /api/show fails", async () => {
    enableDiscoveryEnv();
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return tagsResponse(["qwen3:32b"]);
      }
      if (url.endsWith("/api/show")) {
        return {
          ok: false,
          status: 500,
        };
      }
      return notFoundJsonResponse();
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

    const provider = await runOllamaCatalog({
      env: { OLLAMA_API_KEY: "test-key", VITEST: "", NODE_ENV: "development" },
    });
    const model = provider?.models?.find((entry) => entry.id === "qwen3:32b");
    expect(model?.contextWindow).toBe(128000);
    expectDiscoveryCallCounts(fetchMock, { tags: 1, show: 1 });
  });

  it("caps /api/show requests when /api/tags returns a very large model list", async () => {
    enableDiscoveryEnv();
    const manyModels = Array.from({ length: 250 }, (_, idx) => ({
      name: `model-${idx}`,
      modified_at: "",
      size: 1,
      digest: "",
    }));
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          json: async () => ({ models: manyModels }),
        };
      }
      return {
        ok: true,
        json: async () => ({ model_info: { "llama.context_length": 65536 } }),
      };
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

    const provider = await runOllamaCatalog({
      env: { OLLAMA_API_KEY: "test-key", VITEST: "", NODE_ENV: "development" },
    });
    const models = provider?.models ?? [];
    // 1 call for /api/tags + 200 capped /api/show calls.
    expectDiscoveryCallCounts(fetchMock, { tags: 1, show: 200 });
    expect(models).toHaveLength(200);
  });

  it("should have correct model structure without streaming override", () => {
    const mockOllamaModel = {
      id: "llama3.3:latest",
      name: "llama3.3:latest",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };

    // Native Ollama provider does not need streaming: false workaround
    expect(mockOllamaModel).not.toHaveProperty("params");
  });

  it("should skip discovery fetch when explicit models are configured", async () => {
    await withoutAmbientOllamaEnv(async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
      const explicitModels: ModelDefinitionConfig[] = [
        {
          id: "gpt-oss:20b",
          name: "GPT-OSS 20B",
          reasoning: false,
          input: ["text"] as Array<"text" | "image">,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 81920,
        },
      ];

      const provider = await runOllamaCatalog({
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://remote-ollama:11434/v1",
                models: explicitModels,
                apiKey: "config-ollama-key", // pragma: allowlist secret
              },
            },
          },
        },
        env: { VITEST: "", NODE_ENV: "development" },
      });

      const ollamaCalls = fetchMock.mock.calls.filter(([input]) => {
        const url = String(input);
        return url.endsWith("/api/tags") || url.endsWith("/api/show");
      });
      expect(ollamaCalls).toHaveLength(0);
      expect(provider?.models).toEqual(explicitModels);
      expect(provider?.baseUrl).toBe("http://remote-ollama:11434");
      expect(provider?.api).toBe("ollama");
      expect(provider?.apiKey).toBe("config-ollama-key");
    });
  });

  it("should use synthetic local auth for configured remote providers without apiKey", async () => {
    await withoutAmbientOllamaEnv(async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

      const provider = await runOllamaCatalog({
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://remote-ollama:11434/v1",
                models: [
                  {
                    id: "gpt-oss:20b",
                    name: "GPT-OSS 20B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 81920,
                  },
                ],
              },
            },
          },
        },
        env: { VITEST: "", NODE_ENV: "development" },
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(provider?.baseUrl).toBe("http://remote-ollama:11434");
      expect(provider?.api).toBe("ollama");
      expect(provider?.apiKey).toBe(OLLAMA_LOCAL_AUTH_MARKER);
      expect(provider?.models).toHaveLength(1);
    });
  });

  it("should preserve explicit apiKey from configured remote providers", async () => {
    await withoutAmbientOllamaEnv(async () => {
      const fetchMock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return tagsResponse([]);
        }
        return notFoundJsonResponse();
      });
      vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));

      const provider = await runOllamaCatalog({
        config: {
          models: {
            providers: {
              ollama: {
                baseUrl: "http://remote-ollama:11434/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "configured-remote-model",
                    name: "Configured Remote Model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 8192,
                  },
                ],
                apiKey: "config-ollama-key", // pragma: allowlist secret
              },
            },
          },
        },
        env: { VITEST: "", NODE_ENV: "development" },
      });

      expect(provider?.apiKey).toBe("config-ollama-key");
      expect(provider?.baseUrl).toBe("http://remote-ollama:11434");
      expect(provider?.api).toBe("openai-completions");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
