import type { ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it } from "vitest";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
  resolveFamilyForwardCompatModel,
} from "./provider-model-helpers.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";

function createContext(models: ProviderRuntimeModel[]): ProviderResolveDynamicModelContext {
  return {
    provider: "test-provider",
    modelId: "next-model",
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          models.find((model) => model.provider === providerId && model.id === modelId) ?? null
        );
      },
    } as ModelRegistry,
  };
}

function createTemplateModel(
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    id,
    name: id,
    provider: "test-provider",
    api: "openai-completions",
    ...overrides,
  } as ProviderRuntimeModel;
}

describe("cloneFirstTemplateModel", () => {
  it.each([
    {
      name: "clones the first matching template and applies patches",
      params: {
        providerId: "test-provider",
        modelId: " next-model ",
        templateIds: ["missing", "template-a", "template-b"],
        ctx: createContext([createTemplateModel("template-a", { name: "Template A" })]),
        patch: { reasoning: true },
      },
      expected: {
        id: "next-model",
        name: "next-model",
        provider: "test-provider",
        api: "openai-completions",
        reasoning: true,
      },
    },
    {
      name: "returns undefined when no template exists",
      params: {
        providerId: "test-provider",
        modelId: "next-model",
        templateIds: ["missing"],
        ctx: createContext([]),
      },
      expected: undefined,
    },
  ] as const)("$name", ({ params, expected }) => {
    const model = cloneFirstTemplateModel(params);
    if (expected == null) {
      expect(model).toBeUndefined();
      return;
    }
    expect(model).toEqual(expected);
  });
});

describe("matchesExactOrPrefix", () => {
  it.each([
    {
      id: "MiniMax-M2.7",
      candidates: ["minimax-m2.7"],
      expected: true,
    },
    {
      id: "minimax-m2.7-highspeed",
      candidates: ["MiniMax-M2.7"],
      expected: true,
    },
    {
      id: "glm-5",
      candidates: ["minimax-m2.7"],
      expected: false,
    },
  ] as const)("matches $id against prefixes", ({ id, candidates, expected }) => {
    expect(matchesExactOrPrefix(id, candidates)).toBe(expected);
  });
});

describe("resolveFamilyForwardCompatModel", () => {
  it("selects the first matching family and ordered cross-provider template", () => {
    const ctx = createContext([
      createTemplateModel("template-b", { provider: "template-provider", reasoning: false }),
    ]);

    expect(
      resolveFamilyForwardCompatModel({
        providerId: "test-provider",
        ctx,
        cases: [
          {
            match: (id) => id.startsWith("next-"),
            templateSources: [
              { templateIds: ["missing"] },
              { providerId: "template-provider", templateIds: ["template-b"] },
            ],
            patch: { provider: "test-provider", reasoning: true },
          },
        ],
      }),
    ).toMatchObject({
      id: "next-model",
      name: "next-model",
      provider: "test-provider",
      reasoning: true,
    });
  });

  it("synthesizes a normalized model when a matched family has no template", () => {
    expect(
      resolveFamilyForwardCompatModel({
        providerId: "test-provider",
        ctx: createContext([]),
        cases: [
          {
            match: (id) => id === "next-model",
            templateIds: ["missing"],
            patch: ({ normalizedModelId }) => ({
              api: "openai-responses",
              provider: "test-provider",
              reasoning: normalizedModelId === "next-model",
            }),
          },
        ],
        synthesize: true,
      }),
    ).toMatchObject({
      id: "next-model",
      name: "next-model",
      provider: "test-provider",
      api: "openai-responses",
      reasoning: true,
    });
  });
});
