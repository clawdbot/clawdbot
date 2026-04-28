import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  parseOllamaNumCtxParameter,
  resetOllamaModelShowInfoCacheForTest,
  resolveOllamaApiBase,
  type OllamaTagModel,
} from "./provider-models.js";

describe("ollama provider models", () => {
  afterEach(() => {
    resetOllamaModelShowInfoCacheForTest();
    vi.unstubAllGlobals();
  });

  it("strips /v1 when resolving the Ollama API base", () => {
    expect(resolveOllamaApiBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(resolveOllamaApiBase("http://127.0.0.1:11434///")).toBe("http://127.0.0.1:11434");
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
      { name: "qwen3:32b", digest: "sha256:abc123" },
    ]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [
      { name: "qwen3:32b", digest: "sha256:def456" },
    ]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:abc123",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:def456",
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

    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:abc123" };
    const first = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);
    const second = await enrichOllamaModelsWithContext("http://127.0.0.1:11434", [model]);

    expect(first).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:abc123",
        contextWindow: undefined,
        capabilities: undefined,
      },
    ]);
    expect(second).toEqual([
      {
        name: "qwen3:32b",
        digest: "sha256:abc123",
        contextWindow: 131072,
        capabilities: ["thinking", "tools"],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes /v1 base URLs before fetching and reuses the same cache entry", async () => {
    const model: OllamaTagModel = { name: "qwen3:32b", digest: "sha256:abc123" };
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

    const noCapabilities = buildOllamaModelDefinition("unknown-model", 65536);
    expect(noCapabilities.input).toEqual(["text"]);
    expect(noCapabilities.compat?.supportsUsageInStreaming).toBe(true);
  });

  it("disables tool support when Ollama capabilities omit tools", () => {
    const model = buildOllamaModelDefinition("embeddinggemma:latest", 2048, ["embedding"]);

    expect(model.reasoning).toBe(false);
    expect(model.compat?.supportsTools).toBe(false);
    expect(model.compat?.supportsUsageInStreaming).toBe(true);
  });

  it("parses the last positive Modelfile num_ctx value", () => {
    expect(parseOllamaNumCtxParameter("num_ctx 8192\nnum_ctx 32768")).toBe(32768);
    expect(parseOllamaNumCtxParameter("temperature 0.8\nnum_ctx -1\nnum_ctx 0")).toBeUndefined();
    expect(parseOllamaNumCtxParameter('stop "<|eot_id|>"')).toBeUndefined();
    expect(parseOllamaNumCtxParameter({ num_ctx: 8192 })).toBeUndefined();
  });
});
