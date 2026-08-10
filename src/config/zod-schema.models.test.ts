// Verifies model config schema parsing and validation behavior.
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { applyCommonResponsesParams } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema", () => {
  it.each([
    "claude-cli",
    "azure-openai-responses",
    "clawrouter",
    "gmi",
    "gmi-cloud",
    "gmicloud",
    "moonshot-ai",
    "moonshotai",
    "novita",
    "novita-ai",
    "novitaai",
    "ollama-cloud",
    "qwen-token-plan",
    "x-ai",
    "z.ai",
    "z-ai",
  ])("accepts bundled provider overlay for %s without baseUrl or models", (providerId) => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        [providerId]: {
          timeoutSeconds: 600,
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it.each(["qwen-cli", "qwen-oauth", "qwen-portal"])(
    "rejects retired Qwen Portal provider overlay %s",
    (providerId) => {
      const result = ModelsConfigSchema.safeParse({
        providers: {
          [providerId]: {
            timeoutSeconds: 600,
          },
        },
      });

      expect(result.success).toBe(false);
    },
  );

  it("requires the legacy bailian-token-plan owner to remain an exact custom provider", () => {
    expect(
      ModelsConfigSchema.safeParse({
        providers: { "bailian-token-plan": { timeoutSeconds: 600 } },
      }).success,
    ).toBe(false);
    expect(
      ModelsConfigSchema.safeParse({
        providers: {
          "bailian-token-plan": {
            api: "anthropic-messages",
            baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
            models: [{ id: "qwen3.7-plus", name: "qwen3.7-plus" }],
          },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts google-vertex as a model API from MODEL_APIS", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "google-vertex": {
          baseUrl: "https://{location}-aiplatform.googleapis.com",
          api: "google-vertex",
          apiKey: "gcp-vertex-credentials",
          models: [
            {
              id: "gemini-2.5-pro",
              name: "Gemini 2.5 Pro",
              api: "google-vertex",
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts compat.requiresReasoningContentOnAssistantMessages (issue #89660)", () => {
    // The field is consumed at runtime (detectCompat/getCompat) and is present
    // in the ModelCompat type, but was missing from the strict Zod schema, so a
    // valid config replicating native DeepSeek behavior on a custom provider was
    // rejected with "Unrecognized key(s)". Use the exact config from the issue.
    const result = ModelsConfigSchema.safeParse({
      providers: {
        "my-proxy": {
          baseUrl: "https://my-proxy.example.com/v1",
          models: [
            {
              id: "deepseek-v4-pro",
              name: "DeepSeek V4 Pro",
              reasoning: true,
              compat: {
                thinkingFormat: "deepseek",
                requiresReasoningContentOnAssistantMessages: true,
              },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts catalog-declared temperature compatibility", () => {
    const result = ModelsConfigSchema.safeParse({
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [
            {
              id: "gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              compat: { supportsTemperature: false },
            },
          ],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts configured Responses replay opt-out and preserves provider-native payload effort", () => {
    const parsed = ModelsConfigSchema.parse({
      providers: {
        "custom-responses": {
          baseUrl: "https://compatible.example.com/v1",
          api: "openai-responses",
          models: [
            {
              id: "custom-reasoning",
              name: "Custom Reasoning",
              reasoning: true,
              thinkingLevelMap: {
                off: "none",
                low: "default",
                medium: "default",
                high: "default",
              },
              compat: {
                supportsEncryptedReasoningReplay: false,
              },
            },
          ],
        },
      },
    });

    expect(parsed).toBeDefined();
    if (!parsed) {
      return;
    }

    const configuredModel = parsed.providers?.["custom-responses"]?.models?.[0];
    expect(configuredModel?.compat?.supportsEncryptedReasoningReplay).toBe(false);
    const model = {
      id: configuredModel?.id ?? "",
      name: configuredModel?.name ?? "",
      reasoning: true,
      thinkingLevelMap: configuredModel?.thinkingLevelMap,
      compat: configuredModel?.compat,
      provider: "custom-responses",
      api: "openai-responses",
      baseUrl: "https://compatible.example.com/v1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model<"openai-responses">;

    const params = {} as never;
    applyCommonResponsesParams(
      params,
      model,
      { messages: [] },
      {
        reasoningEffort: "medium",
        reasoningSummary: "concise",
      },
    );

    expect(params).toMatchObject({ reasoning: { effort: "default" } });
    expect(params).not.toHaveProperty("include");
  });
});
