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
  it.each([
    { provider: "custom", id: " alpha", reference: "custom/ alpha" },
    { provider: "custom ", id: "alpha", reference: "custom /alpha" },
  ])("preserves literal canonical components in $reference", ({ provider, id, reference }) => {
    const exact = model(provider, id);
    const models = [model("custom", "alpha"), exact];
    expect(findExactModelReferenceMatch(reference, models)).toBe(exact);
    expect(parseModelPattern(reference, models).model).toBe(exact);
    expect(resolveCliModel({ cliModel: reference, modelRegistry: registry(models) }).model).toBe(
      exact,
    );
  });

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

  it.each(["Alpha", "custom/Alpha", "ALPHA", "custom/ALPHA"])(
    "preserves the first row when %s matches repeated model identities",
    async (reference) => {
      const first = model("custom", "Alpha");
      const models = [first, first, { ...first, name: "Duplicate catalog row" }];
      expect(findExactModelReferenceMatch(reference, models)).toBe(first);
      expect(parseModelPattern(reference, models).model).toBe(first);
      const selected = resolveCliModel({ cliModel: reference, modelRegistry: registry(models) });
      expect(selected.model).toBe(first);
      expect(selected.error).toBeUndefined();
      expect(await resolveModelScope([reference], registry(models))).toEqual([{ model: first }]);
    },
  );

  it("keeps an explicit provider ahead of a slash-containing bare id", () => {
    const scoped = model("custom", "Alpha");
    const models = [model("gateway", "custom/alpha"), scoped];
    expect(findExactModelReferenceMatch("custom/alpha", models)).toBe(scoped);
    expect(
      resolveCliModel({ cliModel: "custom/alpha", modelRegistry: registry(models) }).model,
    ).toBe(scoped);
  });

  it.each(["custom", "CUSTOM"])("preserves the exact provider identity %s", (provider) => {
    const exact = model(provider, "alpha");
    const other = model(provider === "custom" ? "CUSTOM" : "custom", "alpha");
    for (const models of [
      [exact, other],
      [other, exact],
    ]) {
      expect(findExactModelReferenceMatch(`${provider}/alpha`, models)).toBe(exact);
      expect(parseModelPattern(`${provider}/alpha`, models).model).toBe(exact);
      for (const selection of [
        { cliModel: `${provider}/alpha` },
        { cliProvider: provider, cliModel: "alpha" },
      ]) {
        expect(resolveCliModel({ ...selection, modelRegistry: registry(models) }).model).toBe(
          exact,
        );
      }
    }
  });

  it.each([
    { cliModel: "Custom/alpha" },
    { cliProvider: "Custom", cliModel: "alpha" },
    { cliProvider: "Custom", cliModel: "unknown" },
  ])("rejects ambiguous provider identities: %j", (selection) => {
    const models = [model("custom", "alpha"), model("CUSTOM", "alpha")];
    const result = resolveCliModel({ ...selection, modelRegistry: registry(models) });
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ambiguous");
  });

  it.each([{ cliModel: "Custom/alpha" }, { cliProvider: "Custom", cliModel: "alpha" }])(
    "does not disambiguate provider identities through fuzzy matching: %j",
    (selection) => {
      const models = [model("custom", "alpha-one"), model("CUSTOM", "alpha-two")];
      const result = resolveCliModel({ ...selection, modelRegistry: registry(models) });
      expect(result.model).toBeUndefined();
      expect(result.error).toContain("ambiguous");
    },
  );

  it("keeps duplicate names as aliases for registry-first metadata", () => {
    const first = { ...model("custom", "shared"), name: "Canonical title" };
    const later = { ...first, name: "Hidden title", baseUrl: "https://later.example.test" };
    const models = [first, later];
    expect(parseModelPattern("Canonical title", models).model).toBe(first);
    expect(parseModelPattern("Hidden title", models).model).toBe(first);
    const result = resolveCliModel({ cliModel: "Hidden title", modelRegistry: registry(models) });
    expect(result.model).toBe(first);
    expect(result.error).toBeUndefined();
  });

  it("uses the full tuple to disambiguate folded provider names", () => {
    const exact = model("custom", "alpha");
    const models = [exact, model("CUSTOM", "other")];
    expect(findExactModelReferenceMatch("Custom/alpha", models)).toBe(exact);
    expect(parseModelPattern("Custom/alpha", models).model).toBe(exact);
    for (const selection of [
      { cliModel: "Custom/alpha" },
      { cliProvider: "Custom", cliModel: "alpha" },
    ]) {
      expect(resolveCliModel({ ...selection, modelRegistry: registry(models) }).model).toBe(exact);
    }
  });

  it("keeps exact raw-id fallback when folded providers are ambiguous", () => {
    const exact = model("gateway", "Custom/raw-id");
    const models = [model("custom", "other"), model("CUSTOM", "different"), exact];
    const result = resolveCliModel({ cliModel: exact.id, modelRegistry: registry(models) });
    expect(result.model).toBe(exact);
    expect(result.error).toBeUndefined();
  });

  it("strips the entire explicit provider prefix when its identity contains slashes", () => {
    const exact = model("team/custom", "alpha");
    const result = resolveCliModel({
      cliProvider: "team/custom",
      cliModel: "team/custom/alpha",
      modelRegistry: registry([exact]),
    });
    expect(result.model).toBe(exact);
    expect(result.warning).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it.each([false, true])(
    "resolves a slash-provider tuple before raw ids (short provider: %s)",
    (shortProvider) => {
      const exact = model("team/custom", "Alpha");
      const models = [model("gateway", "team/custom/Alpha"), exact];
      if (shortProvider) {
        models.push(model("team", "other"));
      }
      expect(findExactModelReferenceMatch("team/custom/Alpha", models)).toBe(exact);
      expect(parseModelPattern("team/custom/Alpha", models).model).toBe(exact);
      expect(
        resolveCliModel({ cliModel: "team/custom/Alpha", modelRegistry: registry(models) }).model,
      ).toBe(exact);
    },
  );

  it("requires an explicit provider when distinct tuples share a canonical reference", () => {
    const models = [model("team/custom", "Alpha"), model("team", "custom/Alpha")];
    const reference = "team/custom/Alpha";
    expect(findExactModelReferenceMatch(reference, models)).toBeUndefined();
    expect(parseModelPattern(reference, models).warning).toContain("ambiguous");
    const result = resolveCliModel({ cliModel: reference, modelRegistry: registry(models) });
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ambiguous");
    for (const exact of models) {
      expect(
        resolveCliModel({
          cliProvider: exact.provider,
          cliModel: reference,
          modelRegistry: registry(models),
        }).model,
      ).toBe(exact);
    }
  });

  it("keeps mixed-case full tuples ambiguous across different slash boundaries", () => {
    const models = [model("team", "custom/Alpha"), model("TEAM/CUSTOM", "alpha")];
    const reference = "team/custom/alpha";
    expect(findExactModelReferenceMatch(reference, models)).toBeUndefined();
    expect(parseModelPattern(reference, models).warning).toContain("ambiguous");
    const result = resolveCliModel({ cliModel: reference, modelRegistry: registry(models) });
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ambiguous");
    for (const exact of models) {
      expect(findExactModelReferenceMatch(`${exact.provider}/${exact.id}`, models)).toBe(exact);
    }
  });

  it.each([false, true])(
    "infers slash-containing providers for fuzzy patterns (short provider: %s)",
    (shortProvider) => {
      const exact = model("team/custom", "alpha");
      const models = shortProvider ? [model("team", "other"), exact] : [exact];
      const result = resolveCliModel({
        cliModel: "team/custom/alph",
        modelRegistry: registry(models),
      });
      expect(result.model).toBe(exact);
      expect(result.error).toBeUndefined();
      expect(result.warning).toBeUndefined();
    },
  );

  it("does not choose an owner when different slash-provider scopes both match fuzzily", () => {
    const models = [model("team/custom", "alpha"), model("team", "custom/alpha")];
    const result = resolveCliModel({
      cliModel: "team/custom/alph",
      modelRegistry: registry(models),
    });
    expect(result.model).toBeUndefined();
    expect(result.error).toContain("ambiguous");
  });

  it.each([false, true])(
    "preserves slash-provider resolution through thinking suffixes (ambiguous: %s)",
    (ambiguous) => {
      const exact = model("team/custom", "Alpha");
      const models = [exact, model("team", ambiguous ? "custom/Alpha" : "other")];
      const result = resolveCliModel({
        cliModel: "team/custom/Alpha:high",
        modelRegistry: registry(models),
      });
      if (ambiguous) {
        expect(result.model).toBeUndefined();
        expect(result.error).toContain("ambiguous");
      } else {
        expect(result.model).toBe(exact);
        expect(result.thinkingLevel).toBe("high");
        expect(result.error).toBeUndefined();
      }
    },
  );

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

  it("keeps a literal raw colon id before inferring a qualified thinking suffix", () => {
    const qualified = model("custom", "alpha");
    const literal = model("gateway", "custom/alpha:high");
    const modelRegistry = registry([qualified, literal]);
    const result = resolveCliModel({ cliModel: literal.id, modelRegistry });
    expect(result.model).toBe(literal);
    expect(result.thinkingLevel).toBeUndefined();
    const explicit = resolveCliModel({
      cliProvider: "custom",
      cliModel: literal.id,
      modelRegistry,
    });
    expect(explicit.model).toBe(qualified);
    expect(explicit.thinkingLevel).toBe("high");
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
