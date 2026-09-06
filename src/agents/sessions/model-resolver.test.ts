// Model resolver tests pin the startup fallback order for fresh and restored
// agent sessions.
import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { ModelRegistry } from "./model-registry.js";
import {
  findExactModelReferenceMatch,
  findInitialModel,
  parseModelPattern,
  resolveCliModel,
  resolveModelScope,
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

describe("exact model reference selection", () => {
  it.each(["alpha", "custom/alpha", " CUSTOM / alpha "])(
    "prefers the exact model id in %s before case-insensitive matching",
    (reference) => {
      const exact = model("custom", "alpha");
      const folded = model("custom", "Alpha");
      for (const models of [
        [folded, exact],
        [exact, folded],
      ]) {
        expect(findExactModelReferenceMatch(reference, models)).toBe(exact);
      }
    },
  );

  it.each([
    { cliModel: "alpha" },
    { cliModel: "custom/alpha" },
    { cliProvider: "CUSTOM", cliModel: "alpha" },
    { cliProvider: "custom", cliModel: "CUSTOM/alpha" },
  ])("preserves the exact model through CLI selection: %j", (selection) => {
    const exact = model("custom", "alpha");
    const result = resolveCliModel({
      ...selection,
      modelRegistry: registry([model("custom", "Alpha"), exact]),
    });
    expect(result.model).toBe(exact);
    expect(result.error).toBeUndefined();
  });

  it.each(["alpha", "alpha:high"])("preserves an exact scope selection: %s", (pattern) => {
    const exact = model("custom", "alpha");
    const result = parseModelPattern(pattern, [model("custom", "Alpha"), exact]);
    expect(result.model).toBe(exact);
    expect(result.thinkingLevel).toBe(pattern.includes(":") ? "high" : undefined);
  });

  it.each([
    { models: [model("first", "shared"), model("second", "shared")], reference: "shared" },
    { models: [model("custom", "Alpha"), model("custom", "alpha")], reference: "ALPHA" },
    { models: [model("custom", "Alpha"), model("custom", "alpha")], reference: "custom/ALPHA" },
  ])("does not turn ambiguous $reference into a fuzzy or custom model", ({ models, reference }) => {
    expect(findExactModelReferenceMatch(reference, models)).toBeUndefined();
    const parsed = parseModelPattern(reference, models);
    expect(parsed.model).toBeUndefined();
    expect(parsed.warning).toContain("ambiguous");
    const selected = resolveCliModel({ cliModel: reference, modelRegistry: registry(models) });
    expect(selected.model).toBeUndefined();
    expect(selected.error).toContain("ambiguous");
  });

  it("selects an exact bare id across providers before folded candidates", () => {
    const exact = model("second", "alpha");
    const models = [model("first", "Alpha"), exact];
    expect(findExactModelReferenceMatch("alpha", models)).toBe(exact);
    expect(resolveCliModel({ cliModel: "alpha", modelRegistry: registry(models) }).model).toBe(
      exact,
    );
  });

  it("keeps a unique case-insensitive match", () => {
    const available = model("custom", "Alpha");
    expect(findExactModelReferenceMatch("CUSTOM/ALPHA", [available])).toBe(available);
    expect(resolveCliModel({ cliModel: "ALPHA", modelRegistry: registry([available]) }).model).toBe(
      available,
    );
  });

  it("keeps an explicit provider ahead of a slash-containing bare id", () => {
    const scoped = model("custom", "Alpha");
    const models = [model("gateway", "custom/alpha"), scoped];
    expect(findExactModelReferenceMatch("custom/alpha", models)).toBe(scoped);
    expect(
      resolveCliModel({ cliModel: "custom/alpha", modelRegistry: registry(models) }).model,
    ).toBe(scoped);
  });

  it("uses exact raw ids when an inferred provider has no matching model", () => {
    const exact = model("gateway", "custom/alpha");
    const models = [model("custom", "other"), model("gateway", "custom/Alpha"), exact];
    expect(
      resolveCliModel({ cliModel: "custom/alpha", modelRegistry: registry(models) }).model,
    ).toBe(exact);
  });

  it("keeps exact colon ids ahead of thinking suffix parsing", () => {
    const exact = model("custom", "alpha:high");
    expect(parseModelPattern("alpha:high", [model("custom", "alpha"), exact])).toMatchObject({
      model: exact,
      thinkingLevel: undefined,
    });
  });

  it("keeps glob matching case-insensitive without collapsing exact identities", async () => {
    const models = [model("custom", "Alpha"), model("custom", "alpha")];
    expect(await resolveModelScope(["CUSTOM/ALP*:high"], registry(models))).toEqual(
      models.map((entry) => ({ model: entry, thinkingLevel: "high" })),
    );
  });
});

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
  it("keeps human-name matching and prefers an alias over dated versions", () => {
    const alias = { ...model("custom", "family"), name: "Friendly Model" };
    const dated = { ...model("custom", "family-20260901"), name: "Friendly Model Snapshot" };
    expect(parseModelPattern("friendly", [dated, alias]).model).toBe(alias);
    expect(parseModelPattern("family", [model("custom", "family-20260801"), dated]).model).toBe(
      dated,
    );
  });

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
