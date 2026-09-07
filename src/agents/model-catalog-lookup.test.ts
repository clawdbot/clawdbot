import { describe, expect, it } from "vitest";
import {
  findModelCatalogEntry,
  findModelInCatalog,
  resolvePreparedModelThinkingCompat,
} from "./model-catalog-lookup.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const upper: ModelCatalogEntry = { provider: "custom", id: "Reader", name: "Uppercase reader" };
const lower: ModelCatalogEntry = { provider: "custom", id: "reader", name: "Lowercase reader" };

describe("catalog model identity", () => {
  it.each([
    [upper, lower],
    [lower, upper],
  ])("prefers exact identity with %j first", (first, second) => {
    const catalog = [first, second];
    for (const entry of catalog) {
      expect(findModelInCatalog(catalog, " Custom ", ` ${entry.id} `)).toBe(entry);
      expect(findModelCatalogEntry(catalog, { modelId: ` ${entry.id} ` })).toBe(entry);
    }
    expect(findModelInCatalog(catalog, "custom", "READER")).toBeUndefined();
    expect(findModelCatalogEntry(catalog, { modelId: "READER" })).toBeUndefined();
  });

  it("keeps unique case-insensitive SDK matches and providerless ambiguity", () => {
    const other = { ...lower, provider: "other" };
    expect(findModelInCatalog([upper], "CUSTOM", " reader ")).toBe(upper);
    expect(findModelCatalogEntry([upper], { modelId: " reader " })).toBe(upper);
    expect(findModelInCatalog([upper, other], "custom", "reader")).toBe(upper);
    expect(findModelInCatalog([upper, other], "missing", "Reader")).toBeUndefined();
    expect(findModelCatalogEntry([upper, other], { modelId: "Reader" })).toBe(upper);
    expect(findModelCatalogEntry([upper, other], { modelId: "READER" })).toBeUndefined();
    expect(findModelCatalogEntry([lower, other], { modelId: "reader" })).toBeUndefined();
    expect(
      findModelInCatalog([{ ...upper, id: "team/Reader" }], "custom/team", "Reader"),
    ).toBeUndefined();
  });

  it("retains the first exact qualified row without resolving providerless duplicates", () => {
    const duplicate = { ...upper, name: "Another route" };
    expect(findModelInCatalog([upper, duplicate], "custom", "Reader")).toBe(upper);
    expect(findModelCatalogEntry([upper, duplicate], { modelId: "Reader" })).toBeUndefined();
    expect(findModelCatalogEntry([upper], { modelId: " " })).toBeUndefined();
  });

  it("uses provider-owned canonical aliases without applying them to other providers", () => {
    const canonical = { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" };
    const unrelated = { ...canonical, provider: "custom" };
    expect(findModelInCatalog([unrelated, canonical], "openai", "gpt-5.4-codex")).toBe(canonical);
    expect(findModelCatalogEntry([unrelated, canonical], { modelId: "gpt-5.4-codex" })).toBe(
      canonical,
    );
    expect(findModelInCatalog([unrelated], "custom", "gpt-5.4-codex")).toBeUndefined();
  });
});

describe("prepared thinking disablement ownership", () => {
  it.each([
    {
      name: "retains route disablement while replacing enabled tiers",
      selected: ["none", "low"],
      prepared: ["max", "ultra"],
      expected: ["none", "max", "ultra"],
    },
    {
      name: "does not grant disablement to an unknown route",
      selected: undefined,
      prepared: ["none", "max", "ultra"],
      expected: ["max", "ultra"],
    },
    {
      name: "does not grant disablement from nullable route metadata",
      selected: null,
      prepared: ["none", "max"],
      expected: ["max"],
    },
    {
      name: "retains route disablement when enabled tiers are unknown",
      selected: ["none", "low"],
      prepared: null,
      expected: ["none"],
    },
    {
      name: "preserves nullable unknown metadata",
      selected: undefined,
      prepared: null,
      expected: null,
    },
    {
      name: "leaves an absent effort overlay absent",
      selected: ["none", "high"],
      prepared: undefined,
      expected: undefined,
    },
    {
      name: "accepts disablement from the exact physical route",
      selected: undefined,
      prepared: ["none", "high"],
      expected: ["none", "high"],
      routeBound: true,
    },
    {
      name: "accepts nullable metadata from the exact physical route",
      selected: ["none", "high"],
      prepared: null,
      expected: null,
      routeBound: true,
    },
  ])("$name", ({ selected, prepared, expected, routeBound }) => {
    const route = { api: "openai-responses", baseUrl: "https://reasoning.example/v1" } as const;
    const model = {
      provider: "reasoning-provider",
      id: "reasoning-model",
      ...route,
      compat: { supportedReasoningEfforts: selected },
    };
    const result = resolvePreparedModelThinkingCompat({
      model,
      agentRuntime: "native-harness",
      capability: {
        provider: model.provider,
        modelId: model.id,
        agentRuntime: "native-harness",
        ...(routeBound ? { route } : {}),
        compat: { thinkingFormat: "openai", supportedReasoningEfforts: prepared },
      },
    });

    expect(result).toEqual({ thinkingFormat: "openai", supportedReasoningEfforts: expected });
  });
});
