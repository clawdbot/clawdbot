import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { createProviderDynamicModelContext as createContext } from "../test-support/provider-model-test-helpers.js";
import { isModernGoogleModel, resolveGoogleGeminiForwardCompatModel } from "./provider-models.js";

function createTemplateModel(
  provider: string,
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    id,
    name: id,
    provider,
    api: provider === "google-gemini-cli" ? "google-gemini-cli" : "google-generative-ai",
    baseUrl:
      provider === "google-gemini-cli"
        ? "https://cloudcode-pa.googleapis.com"
        : "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  } as ProviderRuntimeModel;
}

function expectModelFields(
  model: ProviderRuntimeModel | undefined,
  fields: Partial<ProviderRuntimeModel>,
) {
  expect(model).toBeDefined();
  if (!model) {
    throw new Error("expected provider model");
  }
  for (const [key, value] of Object.entries(fields)) {
    expect(model[key as keyof ProviderRuntimeModel]).toEqual(value);
  }
}

describe("resolveGoogleGeminiForwardCompatModel", () => {
  it("resolves stable gemini 2.5 flash-lite from direct google templates for Gemini CLI when available", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-gemini-cli",
      ctx: createContext({
        provider: "google-gemini-cli",
        modelId: "gemini-2.5-flash-lite",
        models: [createTemplateModel("google", "gemini-2.5-flash-lite")],
      }),
    });

    expectModelFields(model, {
      provider: "google-gemini-cli",
      id: "gemini-2.5-flash-lite",
      api: "google-generative-ai",
      reasoning: false,
    });
  });

  it("resolves stable gemini 2.5 flash-lite from Gemini CLI templates when direct google templates are unavailable", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-gemini-cli",
      ctx: createContext({
        provider: "google-gemini-cli",
        modelId: "gemini-2.5-flash-lite",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3.1-flash-lite-preview", {
            contextWindow: 1_048_576,
            api: "google-gemini-cli",
            baseUrl: "https://cloudcode-pa.googleapis.com",
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-gemini-cli",
      id: "gemini-2.5-flash-lite",
      api: "google-gemini-cli",
      contextWindow: 1_048_576,
      reasoning: false,
    });
  });

  it("resolves gemini 3.1 pro for google aliases via an alternate template provider", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-vertex",
      ctx: createContext({
        provider: "google-vertex",
        modelId: "gemini-3.1-pro-preview",
        models: [createTemplateModel("google-gemini-cli", "gemini-3-pro-preview")],
      }),
    });

    expectModelFields(model, {
      provider: "google-vertex",
      id: "gemini-3.1-pro-preview",
      api: "google-gemini-cli",
      reasoning: false,
    });
  });

  it("canonicalizes retired Gemini 3 Pro preview requests before cloning templates", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google",
      ctx: createContext({
        provider: "google",
        modelId: "gemini-3-pro-preview",
        models: [createTemplateModel("google", "gemini-3-pro-preview")],
      }),
    });

    expectModelFields(model, {
      provider: "google",
      id: "gemini-3.1-pro-preview",
      api: "google-generative-ai",
      reasoning: true,
    });
  });

  it("keeps Gemini CLI 3.1 clones sourced from CLI templates when both catalogs exist", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-gemini-cli",
      ctx: createContext({
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-pro-preview", {
            api: "google-gemini-cli",
            baseUrl: "https://cloudcode-pa.googleapis.com",
            contextWindow: 1_048_576,
          }),
          createTemplateModel("google", "gemini-3-pro-preview", {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            contextWindow: 200_000,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-gemini-cli",
      id: "gemini-3.1-pro-preview",
      api: "google-gemini-cli",
      baseUrl: "https://cloudcode-pa.googleapis.com",
      contextWindow: 1_048_576,
    });
  });

  it("prefers current Gemini 3.1 Pro templates over retired Gemini 3 Pro templates", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-gemini-cli",
      ctx: createContext({
        provider: "google-gemini-cli",
        modelId: "gemini-3.1-pro-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-pro-preview", {
            contextWindow: 100_000,
          }),
          createTemplateModel("google-gemini-cli", "gemini-3.1-pro-preview", {
            contextWindow: 1_048_576,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-gemini-cli",
      id: "gemini-3.1-pro-preview",
      contextWindow: 1_048_576,
    });
  });

  it("preserves template reasoning metadata instead of forcing it on forward-compat clones", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google",
      ctx: createContext({
        provider: "google",
        modelId: "gemini-3.1-flash-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-flash-preview", {
            reasoning: true,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google",
      id: "gemini-3.1-flash-preview",
      api: "google-gemini-cli",
      reasoning: true,
    });
  });

  it("resolves gemini 3.1 flash from direct google templates", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google",
      ctx: createContext({
        provider: "google",
        modelId: "gemini-3.1-flash-preview",
        models: [
          createTemplateModel("google", "gemini-3-flash-preview", {
            reasoning: false,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google",
      id: "gemini-3.1-flash-preview",
      api: "google-generative-ai",
      reasoning: false,
    });
  });

  it("resolves canonical gemini 3 flash from older Google flash templates when the exact row is missing", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google",
      ctx: createContext({
        provider: "google",
        modelId: "gemini-3-flash-preview",
        models: [
          createTemplateModel("google", "gemini-2.5-flash", {
            contextWindow: 1_048_576,
            reasoning: true,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google",
      id: "gemini-3-flash-preview",
      api: "google-generative-ai",
      input: ["text", "image"],
      contextWindow: 1_048_576,
      reasoning: true,
    });
  });

  it("resolves canonical Gemini CLI 3 flash from Google flash templates when the CLI row is missing", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-gemini-cli",
      ctx: createContext({
        provider: "google-gemini-cli",
        modelId: "gemini-3-flash-preview",
        models: [
          createTemplateModel("google", "gemini-2.5-flash", {
            contextWindow: 1_048_576,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-gemini-cli",
      id: "gemini-3-flash-preview",
      api: "google-generative-ai",
      input: ["text", "image"],
      contextWindow: 1_048_576,
    });
  });

  it("resolves Gemini latest aliases from current Google templates", () => {
    const models = [
      createTemplateModel("google", "gemini-3-pro-preview", { reasoning: true }),
      createTemplateModel("google", "gemini-3-flash-preview", { reasoning: true }),
      createTemplateModel("google", "gemini-3.1-flash-lite-preview", { reasoning: true }),
    ];

    expectModelFields(
      resolveGoogleGeminiForwardCompatModel({
        providerId: "google",
        ctx: createContext({ provider: "google", modelId: "gemini-pro-latest", models }),
      }),
      {
        provider: "google",
        id: "gemini-pro-latest",
        api: "google-generative-ai",
        reasoning: true,
      },
    );
    expectModelFields(
      resolveGoogleGeminiForwardCompatModel({
        providerId: "google",
        ctx: createContext({ provider: "google", modelId: "gemini-flash-latest", models }),
      }),
      {
        provider: "google",
        id: "gemini-flash-latest",
        api: "google-generative-ai",
        reasoning: true,
      },
    );
    expectModelFields(
      resolveGoogleGeminiForwardCompatModel({
        providerId: "google",
        ctx: createContext({ provider: "google", modelId: "gemini-flash-lite-latest", models }),
      }),
      {
        provider: "google",
        id: "gemini-flash-lite-latest",
        api: "google-generative-ai",
        reasoning: true,
      },
    );
  });

  it("resolves Antigravity Gemini 3.1 pro customtools from the low template", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-antigravity",
      ctx: createContext({
        provider: "google-antigravity",
        modelId: "gemini-3.1-pro-preview-customtools",
        models: [
          createTemplateModel("google-antigravity", "gemini-3-pro-low", {
            api: "openai-completions",
            baseUrl: "https://antigravity.example/v1",
            contextWindow: 1_048_576,
            reasoning: true,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-antigravity",
      id: "gemini-3.1-pro-preview-customtools",
      api: "openai-completions",
      baseUrl: "https://antigravity.example/v1",
      contextWindow: 1_048_576,
      reasoning: true,
    });
  });

  it("falls back to the Antigravity high template when the low template is unavailable", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-antigravity",
      ctx: createContext({
        provider: "google-antigravity",
        modelId: "gemini-3.1-pro-preview",
        models: [
          createTemplateModel("google-antigravity", "gemini-3-pro-high", {
            api: "openai-completions",
            maxTokens: 65_536,
            reasoning: true,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-antigravity",
      id: "gemini-3.1-pro-preview",
      api: "openai-completions",
      maxTokens: 65_536,
      reasoning: true,
    });
  });

  it("resolves Antigravity Gemini 3.1 flash variants from the flash template", () => {
    const models = [
      createTemplateModel("google-antigravity", "gemini-3-flash", {
        api: "openai-completions",
        contextWindow: 1_048_576,
      }),
    ];

    expectModelFields(
      resolveGoogleGeminiForwardCompatModel({
        providerId: "google-antigravity",
        ctx: createContext({
          provider: "google-antigravity",
          modelId: "gemini-3.1-flash-preview",
          models,
        }),
      }),
      {
        provider: "google-antigravity",
        id: "gemini-3.1-flash-preview",
        api: "openai-completions",
        contextWindow: 1_048_576,
      },
    );

    expectModelFields(
      resolveGoogleGeminiForwardCompatModel({
        providerId: "google-antigravity",
        ctx: createContext({
          provider: "google-antigravity",
          modelId: "gemini-3.1-flash-lite-preview",
          models,
        }),
      }),
      {
        provider: "google-antigravity",
        id: "gemini-3.1-flash-lite-preview",
        api: "openai-completions",
        contextWindow: 1_048_576,
      },
    );
  });

  it("returns undefined for Antigravity Gemini 3.1 models without a matching template", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-antigravity",
      ctx: createContext({
        provider: "google-antigravity",
        modelId: "gemini-3.1-pro-preview-customtools",
        models: [createTemplateModel("google-antigravity", "claude-opus-4-6-thinking")],
      }),
    });

    expect(model).toBeUndefined();
  });

  it("prefers the flash-lite template before the broader flash prefix", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-vertex",
      ctx: createContext({
        provider: "google-vertex",
        modelId: "gemini-3.1-flash-lite-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-flash-preview", {
            contextWindow: 128_000,
          }),
          createTemplateModel("google-gemini-cli", "gemini-3.1-flash-lite-preview", {
            contextWindow: 1_048_576,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-vertex",
      id: "gemini-3.1-flash-lite-preview",
      contextWindow: 1_048_576,
      reasoning: false,
    });
  });

  it("treats gemini 2.5 ids as modern google models", () => {
    expect(isModernGoogleModel("gemini-2.5-pro")).toBe(true);
    expect(isModernGoogleModel("gemini-2.5-flash-lite")).toBe(true);
    expect(isModernGoogleModel("gemini-1.5-pro")).toBe(false);
  });

  it("treats Gemini latest aliases as modern google models", () => {
    expect(isModernGoogleModel("gemini-pro-latest")).toBe(true);
    expect(isModernGoogleModel("gemini-flash-latest")).toBe(true);
    expect(isModernGoogleModel("gemini-flash-lite-latest")).toBe(true);
  });

  it("treats gemma models as modern google models", () => {
    expect(isModernGoogleModel("gemma-4-26b-a4b-it")).toBe(true);
    expect(isModernGoogleModel("gemma-3-4b-it")).toBe(true);
  });

  it("resolves Gemma 4 models with reasoning enabled regardless of template", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google",
      ctx: createContext({
        provider: "google",
        modelId: "gemma-4-26b-a4b-it",
        models: [createTemplateModel("google", "gemini-3-flash-preview", { reasoning: false })],
      }),
    });

    expectModelFields(model, {
      provider: "google",
      id: "gemma-4-26b-a4b-it",
      reasoning: true,
    });
  });

  it("preserves template reasoning for non-Gemma 4 gemma models", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google",
      ctx: createContext({
        provider: "google",
        modelId: "gemma-3-4b-it",
        models: [createTemplateModel("google", "gemini-3-flash-preview", { reasoning: false })],
      }),
    });

    expectModelFields(model, {
      provider: "google",
      id: "gemma-3-4b-it",
      reasoning: false,
    });
  });
});
