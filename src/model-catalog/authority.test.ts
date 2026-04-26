import { describe, expect, it } from "vitest";
import { mergeModelCatalogRowsByAuthority } from "./index.js";
import type { ModelCatalogSource, NormalizedModelCatalogRow } from "./index.js";

function row(source: ModelCatalogSource, name: string): NormalizedModelCatalogRow {
  return {
    provider: "moonshot",
    id: "kimi-k2.6",
    ref: "moonshot/kimi-k2.6",
    mergeKey: "moonshot::kimi-k2.6",
    name,
    source,
    input: ["text"],
    reasoning: false,
    status: source === "provider-index" ? "preview" : "available",
  };
}

describe("model catalog authority", () => {
  it("keeps user config above manifest, cache, and provider-index preview rows", () => {
    expect(
      mergeModelCatalogRowsByAuthority([
        row("provider-index", "Preview"),
        row("cache", "Cached"),
        row("manifest", "Manifest"),
        row("config", "Configured"),
      ]),
    ).toEqual([expect.objectContaining({ name: "Configured", source: "config" })]);
  });

  it("keeps installed manifest rows above cache and provider-index preview rows", () => {
    expect(
      mergeModelCatalogRowsByAuthority([
        row("provider-index", "Preview"),
        row("runtime-refresh", "Refreshed"),
        row("cache", "Cached"),
        row("manifest", "Manifest"),
      ]),
    ).toEqual([expect.objectContaining({ name: "Manifest", source: "manifest" })]);
  });

  it("uses cache rows above provider-index preview rows", () => {
    expect(
      mergeModelCatalogRowsByAuthority([row("provider-index", "Preview"), row("cache", "Cached")]),
    ).toEqual([expect.objectContaining({ name: "Cached", source: "cache" })]);
  });

  it("uses provider-index preview rows when no higher-authority row exists", () => {
    expect(mergeModelCatalogRowsByAuthority([row("provider-index", "Preview")])).toEqual([
      expect.objectContaining({ name: "Preview", source: "provider-index" }),
    ]);
  });
});
