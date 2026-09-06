import { describe, expect, it } from "vitest";
import { findModelCatalogEntry, findModelInCatalog } from "./model-catalog-lookup.js";
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
