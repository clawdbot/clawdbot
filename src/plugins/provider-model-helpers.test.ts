import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { cloneFirstTemplateModel, matchesExactOrPrefix } from "./provider-model-helpers.js";
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

function expectClonedTemplateModel(
  params: Parameters<typeof cloneFirstTemplateModel>[0],
  expected: Record<string, unknown> | undefined,
) {
  const model = cloneFirstTemplateModel(params);
  if (expected == null) {
    expect(model).toBeUndefined();
    return;
  }
  expect(model).toMatchObject(expected);
}

function expectPrefixMatch(params: {
  id: string;
  candidates: readonly string[];
  expected: boolean;
}) {
  expect(matchesExactOrPrefix(params.id, params.candidates)).toBe(params.expected);
}

function expectPrefixMatchCase(params: {
  id: string;
  candidates: readonly string[];
  expected: boolean;
}) {
  expectPrefixMatch(params);
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
    expectClonedTemplateModel(params, expected);
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
  ] as const)("matches $id against prefixes", expectPrefixMatchCase);
});
