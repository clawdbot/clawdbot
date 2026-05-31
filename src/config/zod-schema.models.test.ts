import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";
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

  it("canonicalizes legacy OpenAI ChatGPT response config before validation", () => {
    const legacyProvider = ["openai", "codex"].join("-");
    const legacyApi = `${legacyProvider}-responses`;
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          [legacyProvider]: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            api: legacyApi,
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                api: legacyApi,
              },
            ],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.models?.providers?.openai?.api).toBe("openai-chatgpt-responses");
    expect(result.config.models?.providers?.openai?.models?.[0]?.api).toBe(
      "openai-chatgpt-responses",
    );
    expect(result.config.models?.providers).not.toHaveProperty(legacyProvider);
  });
});
