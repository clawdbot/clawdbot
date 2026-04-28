import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadProviderIndexCatalogRowsForList } from "./list.provider-index-catalog.js";

const baseConfig = {} satisfies OpenClawConfig;

describe("loadProviderIndexCatalogRowsForList", () => {
  it("returns provider-index preview rows when the provider plugin is enabled", () => {
    expect(
      loadProviderIndexCatalogRowsForList({
        cfg: baseConfig,
        providerFilter: "moonshot",
      }).map((row) => row.ref),
    ).toContain("moonshot/kimi-k2.6");
  });

  it("returns all enabled provider-index preview rows without a provider filter", () => {
    expect(
      loadProviderIndexCatalogRowsForList({
        cfg: baseConfig,
      }).map((row) => row.ref),
    ).toEqual(expect.arrayContaining(["deepseek/deepseek-chat", "moonshot/kimi-k2.6"]));
  });

  it("suppresses provider-index preview rows when the provider plugin is disabled", () => {
    expect(
      loadProviderIndexCatalogRowsForList({
        cfg: {
          plugins: {
            entries: {
              moonshot: { enabled: false },
            },
          },
        },
        providerFilter: "moonshot",
      }),
    ).toEqual([]);
  });
});
