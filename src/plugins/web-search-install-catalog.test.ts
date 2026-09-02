import { describe, expect, it } from "vitest";
import {
  resolveWebSearchInstallCatalogEntry,
  resolveWebSearchInstallCatalogEntries,
  resolveWebSearchInstallCatalogEntriesForEnv,
} from "./web-search-install-catalog.js";

describe("web-search install catalog", () => {
  it("keeps Parallel's keyless provider installable but opt-in", () => {
    const entry = resolveWebSearchInstallCatalogEntry({
      providerId: "parallel-free",
      pluginId: "parallel",
    });

    expect(entry).toMatchObject({
      pluginId: "parallel",
      install: {
        clawhubSpec: "clawhub:@openclaw/parallel-plugin",
        npmSpec: "@openclaw/parallel-plugin",
      },
      provider: {
        id: "parallel-free",
        requiresCredential: false,
        envVars: [],
        credentialPath: "",
      },
    });
    expect(entry?.provider.autoDetectOrder).toBeUndefined();
    expect(
      resolveWebSearchInstallCatalogEntries().some(
        (candidate) => candidate.provider.id === "parallel",
      ),
    ).toBe(true);
  });

  it("resolves credential-backed plugins for env-only auto-detection", () => {
    expect(
      resolveWebSearchInstallCatalogEntriesForEnv({
        EXA_API_KEY: "exa-key",
        FIRECRAWL_API_KEY: "firecrawl-key",
        KIMI_API_KEY: "kimi-key",
        OPENROUTER_API_KEY: "openrouter-key",
        PARALLEL_API_KEY: "parallel-key",
        SEARXNG_BASE_URL: "http://search.local",
        TAVILY_API_KEY: "tavily-key",
      }).map((entry) => entry.pluginId),
    ).toEqual(["exa", "firecrawl", "moonshot", "parallel", "perplexity", "searxng", "tavily"]);
  });
});
