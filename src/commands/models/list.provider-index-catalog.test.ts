// Model provider index catalog tests cover model list catalog indexing and provider grouping.
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
    ).toEqual([
      "moonshot/kimi-k2.6",
      "moonshot/kimi-k2.7-code",
      "moonshot/kimi-k2.7-code-highspeed",
      "moonshot/kimi-k3",
    ]);
  });

  it("returns all enabled provider-index preview rows without a provider filter", () => {
    const refs = loadProviderIndexCatalogRowsForList({
      cfg: baseConfig,
    }).map((row) => row.ref);
    expect(refs).toEqual([
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "moonshot/kimi-k2.6",
      "moonshot/kimi-k2.7-code",
      "moonshot/kimi-k2.7-code-highspeed",
      "moonshot/kimi-k3",
    ]);
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
    ).toStrictEqual([]);
  });
});
