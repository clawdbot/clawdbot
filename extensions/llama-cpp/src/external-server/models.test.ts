import { describe, expect, it } from "vitest";
import { buildLlamaServerProviderConfig, mapLlamaServerModel } from "./models.js";

describe("llama-server model mapping", () => {
  it("maps runtime context and chat-template capabilities", () => {
    expect(
      mapLlamaServerModel(
        {
          id: "ggml-org/model:Q4_K_M",
          object: "model",
          status: { value: "loaded" },
        },
        {
          default_generation_settings: {
            n_ctx: 65536,
            params: { max_tokens: 4096 },
          },
          total_slots: 2,
          build_info: "b10000-deadbeef",
          chat_template_caps: {
            supports_tools: true,
            supports_tool_calls: true,
            supports_typed_content: true,
          },
        },
      ),
    ).toMatchObject({
      status: "loaded",
      buildInfo: "b10000-deadbeef",
      totalSlots: 2,
      config: {
        id: "ggml-org/model:Q4_K_M",
        contextWindow: 65536,
        contextTokens: 65536,
        maxTokens: 4096,
        compat: {
          supportsTools: true,
          supportsUsageInStreaming: true,
          supportsJsonSchemaResponseFormat: true,
          requiresStringContent: false,
          maxTokensField: "max_tokens",
        },
      },
    });
  });

  it("uses an older server's top-level runtime context limit", () => {
    expect(
      mapLlamaServerModel({ id: "model", object: "model" }, { n_ctx: 8192 })?.config,
    ).toMatchObject({
      contextWindow: 8192,
      contextTokens: 8192,
      maxTokens: 8192,
    });
  });

  it("preserves image input advertised by router rows or runtime properties", () => {
    expect(
      mapLlamaServerModel({
        id: "router-vision",
        object: "model",
        architecture: { input_modalities: ["text", "image"] },
      })?.config.input,
    ).toEqual(["text", "image"]);
    expect(
      mapLlamaServerModel(
        { id: "server-vision", object: "model" },
        { modalities: { vision: true } },
      )?.config.input,
    ).toEqual(["text", "image"]);
  });

  it("defaults unknown capabilities conservatively", () => {
    expect(mapLlamaServerModel({ id: "model", object: "model" })?.config.compat).toMatchObject({
      supportsTools: false,
      requiresStringContent: true,
    });
  });

  it("rejects malformed and non-model rows", () => {
    expect(mapLlamaServerModel({ id: " " })).toBeNull();
    expect(mapLlamaServerModel({ id: "model", object: "collection" })).toBeNull();
  });

  it("keeps explicit model rows ahead of discovered rows", () => {
    const explicit = {
      id: "model",
      name: "Configured model",
      reasoning: true,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 2048,
    };
    const discovered = mapLlamaServerModel({ id: "model", object: "model" });
    const second = mapLlamaServerModel({ id: "other", object: "model" });
    if (!discovered || !second) {
      throw new Error("expected model fixtures to map");
    }

    const provider = buildLlamaServerProviderConfig({
      configured: {
        baseUrl: "http://localhost:8080/v1",
        models: [explicit],
      },
      discoveredModels: [discovered, second],
    });

    expect(provider.models).toHaveLength(2);
    expect(provider.models[0]).toBe(explicit);
    expect(provider.models[1]?.id).toBe("other");
  });
});
