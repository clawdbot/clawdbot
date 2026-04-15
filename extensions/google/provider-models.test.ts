import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
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

function createContext(params: {
  provider: string;
  modelId: string;
  models: ProviderRuntimeModel[];
}): ProviderResolveDynamicModelContext {
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          params.models.find(
            (model) =>
              model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
          ) ?? null
        );
      },
    } as ModelRegistry,
  };
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

    expect(model).toMatchObject({
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

    expect(model).toMatchObject({
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

    expect(model).toMatchObject({
      provider: "google-vertex",
      id: "gemini-3.1-pro-preview",
      api: "google-gemini-cli",
      reasoning: false,
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

    expect(model).toMatchObject({
      provider: "google-gemini-cli",
      id: "gemini-3.1-pro-preview",
      api: "google-gemini-cli",
      baseUrl: "https://cloudcode-pa.googleapis.com",
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

    expect(model).toMatchObject({
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

    expect(model).toMatchObject({
      provider: "google",
      id: "gemini-3.1-flash-preview",
      api: "google-generative-ai",
      reasoning: false,
    });
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

    expect(model).toMatchObject({
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

    expect(model).toMatchObject({
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

    expect(model).toMatchObject({
      provider: "google",
      id: "gemma-3-4b-it",
      reasoning: false,
    });
  });
});
