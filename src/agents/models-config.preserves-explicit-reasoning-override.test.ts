import { describe, expect, it } from "vitest";
import { mergeProviderModels, mergeProviders } from "./models-config.merge.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";

const MINIMAX_MODEL_ID = "MiniMax-M2.7";

function createMinimaxProvider(model: NonNullable<ProviderConfig["models"]>[number]) {
  return {
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    models: [model],
  } satisfies ProviderConfig;
}

function createMinimaxModel(
  overrides: Partial<NonNullable<ProviderConfig["models"]>[number]> = {},
): NonNullable<ProviderConfig["models"]>[number] {
  return {
    id: MINIMAX_MODEL_ID,
    name: "MiniMax M2.7",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
    ...overrides,
  } as NonNullable<ProviderConfig["models"]>[number];
}

function createMinimaxModelWithoutReasoning(): NonNullable<ProviderConfig["models"]>[number] {
  return {
    id: MINIMAX_MODEL_ID,
    name: "MiniMax M2.7",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  } as NonNullable<ProviderConfig["models"]>[number];
}

function mergedMinimaxModel(
  explicitModel: NonNullable<ProviderConfig["models"]>[number],
): NonNullable<ProviderConfig["models"]>[number] | undefined {
  return mergeProviderModels(
    createMinimaxProvider(createMinimaxModel({ reasoning: true })),
    createMinimaxProvider(explicitModel),
  ).models?.find((model) => model.id === MINIMAX_MODEL_ID);
}

describe("models-config: explicit reasoning override", () => {
  it("preserves user reasoning:false when the built-in catalog has reasoning:true", () => {
    const merged = mergedMinimaxModel(createMinimaxModel({ reasoning: false }));

    expect(merged?.id).toBe(MINIMAX_MODEL_ID);
    expect(merged?.reasoning).toBe(false);
  });

  it("keeps reasoning unset when user omits the field", () => {
    const merged = mergeProviders({
      implicit: {},
      explicit: {
        minimax: createMinimaxProvider(createMinimaxModelWithoutReasoning()),
      },
    }).minimax?.models?.find((model) => model.id === MINIMAX_MODEL_ID);

    expect(merged?.id).toBe(MINIMAX_MODEL_ID);
    expect(merged).not.toHaveProperty("reasoning");
  });
});
