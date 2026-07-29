// Model resolver tests pin the startup fallback order for fresh and restored
// agent sessions.
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { ModelRegistry } from "./model-registry.js";
import {
  findInitialModel,
  parseModelPattern,
  resolveCliModel,
  restoreModelFromSession,
} from "./model-resolver.js";

function model(provider: string, id: string): Model {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: `https://${provider}.example.test`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function registry(models: Model[], authenticatedModels: Model[] = models): ModelRegistry {
  return {
    find: (provider: string, modelId: string) =>
      models.find((entry) => entry.provider === provider && entry.id === modelId),
    getAll: () => models,
    getAvailable: () => authenticatedModels,
    hasConfiguredAuth: (entry: Model) => authenticatedModels.includes(entry),
  } as ModelRegistry;
}

describe("model resolver fallback selection", () => {
  it("prefers the product default when no configured or scoped model is selected", async () => {
    const productDefault = model(DEFAULT_PROVIDER, DEFAULT_MODEL);
    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      modelRegistry: registry([model("anthropic", "claude-opus-4.7"), productDefault]),
    });

    expect(result.model).toBe(productDefault);
  });

  it("falls back to registry order instead of core provider defaults", async () => {
    // Restored sessions can reference removed models; choose an authenticated
    // registry model rather than reviving a hard-coded provider default.
    const firstAvailable = model("anthropic", "claude-haiku");
    const result = await restoreModelFromSession(
      "openai",
      "missing-model",
      undefined,
      false,
      registry([firstAvailable, model("anthropic", "claude-opus-4.7")]),
    );

    expect(result.model).toBe(firstAvailable);
  });

  it("ignores an unauthenticated saved default", async () => {
    const savedDefault = model("saved-provider", "saved-model");
    const available = model("available-provider", "available-model");

    const result = await findInitialModel({
      scopedModels: [],
      isContinuing: false,
      defaultProvider: savedDefault.provider,
      defaultModelId: savedDefault.id,
      modelRegistry: registry([savedDefault, available], [available]),
    });

    expect(result.model).toBe(available);
  });
});

describe("custom model fallback", () => {
  it.each([
    { suffix: "high", reasoning: true },
    { suffix: "off", reasoning: false },
  ] as const)("parses :$suffix and configures reasoning", ({ suffix, reasoning }) => {
    const providerModel = model("custom-provider", "known-model");
    const result = resolveCliModel({
      cliModel: `custom-provider/new-model:${suffix}`,
      modelRegistry: registry([providerModel]),
    });

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "custom-provider",
      id: "new-model",
      reasoning,
    });
    expect(result.thinkingLevel).toBe(suffix);
  });

  it("keeps an invalid suffix as part of the custom model id", () => {
    const result = resolveCliModel({
      cliProvider: "custom-provider",
      cliModel: "new-model:specialized",
      modelRegistry: registry([model("custom-provider", "known-model")]),
    });

    expect(result.model?.id).toBe("new-model:specialized");
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("preserves an explicit thinking level for a custom model", () => {
    const result = resolveCliModel({
      cliProvider: "custom-provider",
      cliModel: "new-model",
      cliThinking: "low",
      modelRegistry: registry([model("custom-provider", "known-model")]),
    });

    expect(result.model).toMatchObject({ id: "new-model", reasoning: true });
    expect(result.thinkingLevel).toBe("low");
  });

  it("uses the parsed thinking level during initial model selection", async () => {
    const result = await findInitialModel({
      cliProvider: "custom-provider",
      cliModel: "new-model:high",
      scopedModels: [],
      isContinuing: false,
      modelRegistry: registry([model("custom-provider", "known-model")]),
    });

    expect(result.model).toMatchObject({ id: "new-model", reasoning: true });
    expect(result.thinkingLevel).toBe("high");
  });
});

describe("parseModelPattern version sorting", () => {
  it("selects the numerically highest version when aliases span double-digit minors", () => {
    const models = [
      model("anthropic", "claude-opus-4-9"),
      model("anthropic", "claude-opus-4-10"),
      model("anthropic", "claude-opus-4-11"),
    ];
    const result = parseModelPattern("opus", models);
    expect(result.model?.id).toBe("claude-opus-4-11");
  });
});
