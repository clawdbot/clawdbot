// Ollama tests cover provider models plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaProvider,
  buildOllamaModelDefinition,
  capLocalOllamaProviderContext,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
  resolveOllamaApiBase,
  type OllamaTagModel,
} from "./provider-models.js";

describe("ollama provider models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips /v1 when resolving the Ollama API base", () => {
    expect(resolveOllamaApiBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaApiBase("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
  });

  it("caps local discovered runtime context while preserving native metadata", () => {
    const provider = capLocalOllamaProviderContext({
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [
        buildOllamaModelDefinition("qwen3.5:4b", 262_144),
        buildOllamaModelDefinition("small", 16_384),
      ],
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ contextWindow: 262_144, contextTokens: 32_768 }),
      expect.objectContaining({ contextWindow: 16_384, contextTokens: 16_384 }),
    ]);
  });

  it("sets discovered models with context windows from /api/show", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3:8b" }, { name: "deepseek-r1:14b" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "llama3:8b") {
        return jsonResponse({ model_info: { "llama.context_length": 65536 } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      { name: "llama3:8b", contextWindow: 65536, capabilities: undefined },
      { name: "deepseek-r1:14b", contextWindow: undefined, capabilities: undefined },
    ]);
    const fallbackModel = expectDefined(enriched[1], "fallback Ollama model");
    expect(
      buildOllamaModelDefinition(
        fallbackModel.name,
        fallbackModel.contextWindow,
        fallbackModel.capabilities,
      ).compat?.supportsTools,
    ).toBe(true);
  });

  it("forwards remote auth to model listing and show probes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer cloud-key");
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "glm-5.2:cloud" }] });
      }
      if (url.endsWith("/api/show")) {
        return jsonResponse({
          model_info: { "glm5.2.context_length": 1_000_000 },
          capabilities: ["completion", "thinking", "tools"],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = await buildOllamaProvider("https://ollama.com", {
      apiKey: "cloud-key",
    });

    expect(provider.models).toEqual([
      expect.objectContaining({
        id: "glm-5.2:cloud",
        contextWindow: 1_000_000,
        maxTokens: 8_192,
        reasoning: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("scopes cached show metadata by credential", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "private-model", digest: "stable" }] });
      }
      const apiKey = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        model_info: {
          "private.context_length": apiKey === "Bearer account-a" ? 16_000 : 32_000,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await buildOllamaProvider("https://ollama.example.com", {
      apiKey: "account-a",
    });
    const second = await buildOllamaProvider("https://ollama.example.com", {
      apiKey: "account-b",
    });

    expect(first.models?.[0]?.contextWindow).toBe(16_000);
    expect(second.models?.[0]?.contextWindow).toBe(32_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recognizes the static Ollama Cloud GLM-5.2 model as reasoning-capable", () => {
    expect(buildOllamaModelDefinition("glm-5.2:cloud")).toEqual(
      expect.objectContaining({
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 8192,
      }),
    );
  });

  it("uses Modelfile num_ctx when it expands the discovered context window", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3-32k:latest" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "llama.context_length": 8192 },
        parameters: 'stop "<|eot_id|>"\nnum_ctx 32768\nnum_keep 5',
        capabilities: ["completion"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      {
        name: "llama3-32k:latest",
        contextWindow: 32768,
        capabilities: ["completion"],
      },
    ]);
  });

  it("keeps the larger native context window when Modelfile num_ctx is smaller", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3.2:latest" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "llama.context_length": 131072 },
        parameters: "num_ctx 4096",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0]?.contextWindow).toBe(131072);
  });

  it("uses positive num_ctx when /api/show omits model context metadata", async () => {
    const models: OllamaTagModel[] = [{ name: "custom-model:latest" }];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: {},
        parameters: "num_ctx 16384",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched[0]?.contextWindow).toBe(16384);
  });

  it("sets models with vision capability from /api/show capabilities", async () => {
    const models: OllamaTagModel[] = [{ name: "kimi-k2.5:cloud" }, { name: "glm-5.1:cloud" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      if (body.name === "kimi-k2.5:cloud") {
        return jsonResponse({
          model_info: { "kimi-k2.context_length": 262144 },
          capabilities: ["vision", "thinking", "completion", "tools"],
        });
      }
      if (body.name === "glm-5.1:cloud") {
        return jsonResponse({
          model_info: { "glm5.context_length": 202752 },
          capabilities: ["thinking", "completion", "tools"],
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(enriched).toEqual([
      {
        name: "kimi-k2.5:cloud",
        contextWindow: 262144,
        capabilities: ["vision", "thinking", "completion", "tools"],
      },
      {
        name: "glm-5.1:cloud",
        contextWindow: 202752,
        capabilities: ["thinking", "completion", "tools"],
      },
    ]);
  });

  it("reuses cached /api/show metadata when the model digest is unchanged", async () => {
    const models: OllamaTagModel[] = [
      { name: "qwen3:32b", digest: "sha256:abc123", modified_at: "2026-04-11T00:00:00Z" },
    ];
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model_info: { "qwen3.context_length": 131072 },
        capabilities: ["thinking", "tools"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", models);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached /api/show metadata when the model digest changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 131072 },
          capabilities: ["thinking", "tools"],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 262144 },
          capabilities: ["vision", "thinking", "tools"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [
      { name: "qwen3:32b", digest: "sha256:refresh-old" },
    ]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [
      { name: "qwen3:32b", digest: "sha256:refresh-new" },
    ]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:refresh-old",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:refresh-new",
        contextWindow: 262144,
        capabilities: ["vision", "thinking", "tools"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries /api/show after an empty result for the same digest", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(
        jsonResponse({
          model_info: { "qwen3.context_length": 131072 },
          capabilities: ["thinking", "tools"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:retry-empty" };
    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:retry-empty",
        contextWindow: undefined,
        capabilities: undefined,
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:retry-empty",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes /v1 base URLs before fetching and reuses the same cache entry", async () => {
    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:normalized-base" };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("http://127.0.0.1:11434/api/show");
      expect(JSON.parse(requestBodyText(init?.body))).toEqual({ name: "qwen3:32b" });
      return jsonResponse({
        model_info: { "qwen3.context_length": 131072 },
        capabilities: ["thinking", "tools"],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434/v1/", [model]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("buildOllamaModelDefinition sets input to text+image when vision capability is present", () => {
    const visionModel = buildOllamaModelDefinition("kimi-k2.5:cloud", 262144, [
      "vision",
      "completion",
      "tools",
      "thinking",
    ]);
    expect(visionModel.input).toEqual(["text", "image"]);
    expect(visionModel.reasoning).toBe(true);
    expect(visionModel.compat?.supportsTools).toBe(true);
    expect(visionModel.compat?.supportsUsageInStreaming).toBe(true);

    const textModel = buildOllamaModelDefinition("glm-5.1:cloud", 202752, ["completion", "tools"]);
    expect(textModel.input).toEqual(["text"]);
    expect(textModel.reasoning).toBe(false);
    expect(textModel.compat?.supportsTools).toBe(true);
    expect(textModel.compat?.supportsUsageInStreaming).toBe(true);

    const deepseekCloudModel = buildOllamaModelDefinition("deepseek-v4-pro:cloud", 1048576, [
      "completion",
      "tools",
    ]);
    expect(deepseekCloudModel.reasoning).toBe(true);
    expect(deepseekCloudModel.compat?.supportsTools).toBe(true);

    const deepseekCloudModelWithoutCapabilities = buildOllamaModelDefinition(
      "deepseek-v4-flash:cloud",
      1048576,
    );
    expect(deepseekCloudModelWithoutCapabilities.reasoning).toBe(true);

    const noCapabilities = buildOllamaModelDefinition("unknown-model", 65536);
    expect(noCapabilities.input).toEqual(["text"]);
    expect(noCapabilities.compat?.supportsTools).toBe(true);
    expect(noCapabilities.compat?.supportsUsageInStreaming).toBe(true);
  });

  it("disables tool support when Ollama capabilities omit tools", () => {
    const model = buildOllamaModelDefinition("embeddinggemma:latest", 2048, ["embedding"]);

    expect(model.reasoning).toBe(false);
    expect(model.compat?.supportsTools).toBe(false);
    expect(model.compat?.supportsUsageInStreaming).toBe(true);
  });

  it.each([
    { parameters: "num_ctx 8192\nnum_ctx 32768", expected: 32768 },
    { parameters: "temperature 0.8\nnum_ctx -1\nnum_ctx 0", expected: undefined },
    { parameters: 'stop "<|eot_id|>"', expected: undefined },
    { parameters: { num_ctx: 8192 }, expected: undefined },
  ])("reads Modelfile num_ctx through the model show query", async ({ parameters, expected }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ model_info: {}, parameters })),
    );

    const info = await queryOllamaModelShowInfo("http://127.0.0.1:11434", "test-model");

    expect(info.contextWindow).toBe(expected);
  });

  it("fails soft and stops reading when discovery streams exceed the JSON byte cap", async () => {
    // Larger than the shared 16 MiB readProviderJsonResponse cap so the bounded reader cancels
    // the stream mid-flight; if the cap were removed the reader would buffer the whole payload.
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32; // 32 MiB advertised body, double the cap.
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const makeOversizedJsonResponse = (): Response => {
      bytesPulled = 0;
      canceled = false;
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          pulled += 1;
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOversizedJsonResponse()),
    );
    const tags = await fetchOllamaModels("http://127.0.0.1:11434");
    expect(tags).toEqual({ reachable: false, models: [] });
    expect(canceled).toBe(true);
    // Only the bounded prefix is pulled, never the full advertised 32 MiB stream.
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => makeOversizedJsonResponse()),
    );
    const showInfo = await queryOllamaModelShowInfo("http://127.0.0.1:11434", "evil-model:latest");
    expect(showInfo).toEqual({});
    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });
});
