// Ollama tests cover provider models plugin behavior.
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OLLAMA_DEFAULT_CONTEXT_WINDOW } from "./defaults.js";
import {
  buildOllamaProvider,
  buildOllamaModelDefinition,
  capLocalOllamaProviderContext,
  enrichOllamaModelsWithContext,
  fetchLoadedOllamaModelNames,
  isOllamaCloudModel,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
  readOllamaModelShowInfo,
  resolveOllamaApiBase,
  type OllamaTagModel,
} from "./provider-models.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
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
}

describe("ollama provider models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips /v1 when resolving the Ollama API base", () => {
    expect(resolveOllamaApiBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaApiBase("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
  });

  it("declares every exact currently served Ollama Cloud model id", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      modelCatalog: {
        providers: Record<
          string,
          {
            models: Array<{
              id: string;
              status?: string;
              contextWindow: number;
              input: string[];
              reasoning: boolean;
              cost?: {
                input?: number;
                output?: number;
                cacheRead?: number;
              };
            }>;
          }
        >;
      };
    };
    const models = manifest.modelCatalog.providers["ollama-cloud"]?.models ?? [];
    const declared = new Map(models.map((model) => [model.id, model]));

    const servedModels = [
      ["glm-5.1", 202_752, ["text"], true],
      ["glm-5.2", 1_000_000, ["text"], true],
      ["minimax-m2.7", 196_608, ["text"], true],
      ["deepseek-v4-flash", 1_048_576, ["text"], true],
      ["deepseek-v4-flash:0731", 1_048_576, ["text"], true],
      ["deepseek-v4-flash:preview", 1_048_576, ["text"], true],
      ["deepseek-v4-pro", 1_048_576, ["text"], true],
      ["deepseek-v4-pro:0813", 1_048_576, ["text"], true],
      ["deepseek-v4-pro:preview", 524_288, ["text"], true],
      ["gemma4", 262_144, ["text", "image"], true],
      ["gemma4:31b", 262_144, ["text", "image"], true],
      ["gpt-oss:120b", 131_072, ["text"], true],
      ["gpt-oss:20b", 131_072, ["text"], true],
      ["kimi-k2.6", 262_144, ["text", "image"], true],
      ["kimi-k2.7-code", 262_144, ["text", "image"], true],
      ["kimi-k3", 1_048_576, ["text", "image"], true],
      ["minimax-m3", 524_288, ["text", "image"], true],
      ["mistral-large-3:675b", 262_144, ["text", "image"], false],
      ["nemotron-3-nano:30b", 262_144, ["text"], true],
      ["nemotron-3-super", 262_144, ["text"], true],
      ["nemotron-3-ultra", 262_144, ["text"], true],
      ["qwen3.5", 262_144, ["text", "image"], true],
      ["qwen3.5:397b", 262_144, ["text", "image"], true],
    ] as const;
    servedModels.forEach(([id, contextWindow, input, reasoning]) => {
      expect(declared.get(id)).toMatchObject({ contextWindow, input, reasoning });
    });
    expect([...declared.keys()].toSorted()).toEqual(
      [...servedModels.map(([id]) => id), "kimi-k2.5"].toSorted(),
    );
    expect(declared.get("kimi-k2.5")).toMatchObject({ status: "deprecated" });
    expect(declared.get("kimi-k3")?.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3 });
  });

  it("inspects local models using Ollama's canonical model request field", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ model_info: {} }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await readOllamaModelShowInfo("http://127.0.0.1:11434", "gemma4:e2b");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(requestBodyText(request?.body))).toEqual({ model: "gemma4:e2b" });
  });

  it("caps local discovered runtime context while preserving native metadata", () => {
    const provider = capLocalOllamaProviderContext({
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      models: [
        buildOllamaModelDefinition("qwen3.5:4b", 262_144),
        buildOllamaModelDefinition("small", 16_384),
        buildOllamaModelDefinition("glm-5.2:cloud", 1_000_000),
        buildOllamaModelDefinition("gpt-oss:120b-cloud", 131_072),
        buildOllamaModelDefinition("local-cloud", 65_536),
      ],
    });

    expect(provider.models).toEqual([
      expect.objectContaining({ contextWindow: 262_144, contextTokens: 32_768 }),
      expect.objectContaining({ contextWindow: 16_384, contextTokens: 16_384 }),
      expect.objectContaining({ id: "glm-5.2:cloud", contextWindow: 1_000_000 }),
      expect.objectContaining({ id: "gpt-oss:120b-cloud", contextWindow: 131_072 }),
      expect.objectContaining({ id: "local-cloud", contextTokens: 32_768 }),
    ]);
    expect(provider.models?.[2]).not.toHaveProperty("contextTokens");
    expect(provider.models?.[3]).not.toHaveProperty("contextTokens");
  });

  it.each([
    ["glm-5.2:cloud", true],
    ["gpt-oss:120b-cloud", true],
    ["local-cloud", false],
    ["invalid:cloud-cloud", false],
    ["invalid:local:cloud", false],
    ["invalid:local-cloud", false],
    ["invalid:cloud:local", false],
  ])("classifies Ollama model source %s", (modelId, expected) => {
    expect(isOllamaCloudModel(modelId)).toBe(expected);
  });

  it("sets discovered models with context windows from /api/show", async () => {
    const models: OllamaTagModel[] = [{ name: "llama3:8b" }, { name: "deepseek-r1:14b" }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.endsWith("/api/show")) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      const body = JSON.parse(requestBodyText(init?.body)) as { model?: string };
      if (body.model === "llama3:8b") {
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

  it("reads loaded models from /api/ps with remote auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://ollama.example.com/api/ps");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
      return jsonResponse({
        models: [{ name: "qwen3.5:4b" }, { model: "llama3.3:70b" }, { name: "   " }, {}],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLoadedOllamaModelNames("https://ollama.example.com/v1", {
        apiKey: "private-key",
      }),
    ).resolves.toEqual({
      reachable: true,
      models: ["qwen3.5:4b", "llama3.3:70b"],
    });
  });

  it("discovers a chat model after 200 embedding-only catalog entries", async () => {
    const embeddingModels = Array.from({ length: 200 }, (_, index) => ({
      name: `embedding-${index}:latest`,
    }));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({
          models: [...embeddingModels, { name: "qwen-chat:latest" }],
        });
      }
      if (url.endsWith("/api/show")) {
        const body = JSON.parse(requestBodyText(init?.body)) as { model?: string };
        const completion = body.model === "qwen-chat:latest";
        return jsonResponse({
          capabilities: completion ? ["completion", "tools"] : ["embedding"],
          model_info: completion ? { "qwen.context_length": 32_768 } : {},
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = await buildOllamaProvider("http://127.0.0.1:11434");

    expect(provider.models?.map((model) => model.id)).toEqual(["qwen-chat:latest"]);
    expect(provider.models?.[0]?.contextWindow).toBe(32_768);
    expect(fetchMock).toHaveBeenCalledTimes(202);
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

  it("resolves known cloud context windows for bare and :cloud model refs", () => {
    // A suffixed ref must not silently drop to the generic default when live
    // inspection is unavailable; both spellings name the same cloud model.
    for (const modelId of ["kimi-k3", "kimi-k3:cloud"]) {
      expect(buildOllamaModelDefinition(modelId)).toEqual(
        expect.objectContaining({ id: modelId, contextWindow: 1_048_576 }),
      );
    }
  });

  it("keeps the generic default for cloud models with no known context window", () => {
    expect(buildOllamaModelDefinition("not-a-known-model:cloud")).toEqual(
      expect.objectContaining({ contextWindow: OLLAMA_DEFAULT_CONTEXT_WINDOW }),
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
      const body = JSON.parse(requestBodyText(init?.body)) as { model?: string };
      if (body.model === "kimi-k2.5:cloud") {
        return jsonResponse({
          model_info: { "kimi-k2.context_length": 262144 },
          capabilities: ["vision", "thinking", "completion", "tools"],
        });
      }
      if (body.model === "glm-5.1:cloud") {
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
      expect(JSON.parse(requestBodyText(init?.body))).toEqual({ model: "qwen3:32b" });
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
    expect(visionModel.compat?.supportsJsonSchemaResponseFormat).toBe(false);

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
    expect(noCapabilities.compat?.supportsJsonSchemaResponseFormat).toBe(true);
  });

  it("disables tool support when Ollama capabilities omit tools", () => {
    const model = buildOllamaModelDefinition("embeddinggemma:latest", 2048, ["embedding"]);

    expect(model.reasoning).toBe(false);
    expect(model.compat?.supportsTools).toBe(false);
    expect(model.compat?.supportsUsageInStreaming).toBe(true);
  });

  it("keeps failed inspection distinct from omitted and empty capabilities", () => {
    const uninspected = buildOllamaModelDefinition("deepseek-r1:14b", 65536);
    const authoritativeEmpty = buildOllamaModelDefinition("deepseek-r1:14b", 65536, []);
    const inspectionFailed = buildOllamaModelDefinition("deepseek-r1:14b", 65536, undefined, {
      showInspectionFailed: true,
    });

    expect(uninspected).toMatchObject({
      reasoning: true,
      compat: { supportsTools: true },
    });
    expect(authoritativeEmpty).toMatchObject({
      reasoning: false,
      compat: { supportsTools: false },
    });
    expect(inspectionFailed).toMatchObject({
      reasoning: true,
      compat: { supportsTools: false },
    });
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

  it("cancels non-OK discovery response bodies before fallback results", async () => {
    const tagsResponse = cancelTrackedResponse("ollama unavailable", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tagsResponse.response),
    );

    await expect(fetchOllamaModels("http://127.0.0.1:11434")).resolves.toEqual({
      reachable: true,
      models: [],
    });
    expect(tagsResponse.wasCanceled()).toBe(true);

    const psResponse = cancelTrackedResponse("process listing unavailable", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => psResponse.response),
    );

    await expect(fetchLoadedOllamaModelNames("http://127.0.0.1:11434")).resolves.toEqual({
      reachable: true,
      models: [],
    });
    expect(psResponse.wasCanceled()).toBe(true);

    const showResponse = cancelTrackedResponse("model unavailable", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => showResponse.response),
    );

    await expect(queryOllamaModelShowInfo("http://127.0.0.1:11434", "llama3:8b")).resolves.toEqual({
      showInspectionFailed: true,
    });
    expect(showResponse.wasCanceled()).toBe(true);
  });

  it("reports failed strict model inspections while releasing their response bodies", async () => {
    const showResponse = cancelTrackedResponse("model unavailable", { status: 503 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => showResponse.response),
    );

    await expect(readOllamaModelShowInfo("http://127.0.0.1:11434", "llama3:8b")).rejects.toThrow(
      "Ollama model inspection failed with HTTP 503",
    );
    expect(showResponse.wasCanceled()).toBe(true);
  });

  it("closes real failed discovery sockets while preserving successful discovery", async () => {
    const sockets = new Set<Socket>();
    const socketClosures = new Map<string, Promise<void>>();
    let mode: "failure" | "success" = "failure";

    const server = createServer((request, response) => {
      const path = request.url;
      if (path !== "/api/tags" && path !== "/api/show") {
        response.writeHead(404);
        response.end();
        return;
      }

      if (mode === "failure") {
        socketClosures.set(
          path,
          new Promise<void>((resolve) => {
            request.socket.once("close", () => resolve());
          }),
        );
        response.writeHead(503, { "content-type": "text/plain" });
        // Leave the body open so only real client cancellation can close its socket.
        response.write("ollama unavailable");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      if (path === "/api/tags") {
        response.end(JSON.stringify({ models: [{ name: "llama3:8b" }] }));
        return;
      }
      response.end(
        JSON.stringify({
          model_info: { "llama.context_length": 32768 },
          capabilities: ["completion", "tools"],
        }),
      );
    });

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    const waitForSocketClose = async (path: string): Promise<void> => {
      const closed = socketClosures.get(path);
      if (!closed) {
        throw new Error(`No failed discovery socket was recorded for ${path}`);
      }

      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(`Failed discovery socket was not closed for ${path}`));
            }, 2_000);
          }),
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
    };

    const listening = once(server, "listening");
    try {
      server.listen(0, "127.0.0.1");
      await listening;

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Ollama test server did not expose a TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [],
      });
      await waitForSocketClose("/api/tags");

      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        showInspectionFailed: true,
      });
      await waitForSocketClose("/api/show");

      mode = "success";
      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [{ name: "llama3:8b" }],
      });
      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        contextWindow: 32768,
        capabilities: ["completion", "tools"],
      });
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  });

  it("keeps tools off after a live /api/show failure", async () => {
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/tags") {
        response.end(
          JSON.stringify({
            models: [{ name: "deepseek-r1:14b", digest: "sha256:show-failure" }],
          }),
        );
        return;
      }
      if (request.url === "/api/show") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "show failed" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });

    const listening = once(server, "listening");
    try {
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Ollama test server did not expose a TCP address");
      }

      const provider = await buildOllamaProvider(`http://127.0.0.1:${address.port}`);
      const model = expectDefined(provider.models?.[0], "show-failed Ollama model");

      expect(model.id).toBe("deepseek-r1:14b");
      expect(model.compat?.supportsTools).toBe(false);
      expect(model.reasoning).toBe(true);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
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
    expect(showInfo).toEqual({ showInspectionFailed: true });
    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });
});
