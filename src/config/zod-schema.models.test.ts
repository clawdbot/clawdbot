// Verifies model config schema parsing and validation behavior.
import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("ModelsConfigSchema", () => {
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
