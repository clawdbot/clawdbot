// Verifies model config schema parsing and validation behavior.
import { describe, expect, it } from "vitest";
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
    "qwen-cli",
    "qwen-oauth",
    "qwen-portal",
    "qwen-token-plan",
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
});
