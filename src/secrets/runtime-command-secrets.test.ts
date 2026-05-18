import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCommandSecretsFromActiveRuntimeSnapshot } from "./runtime-command-secrets.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

describe("runtime command secrets", () => {
  const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const previousTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    if (previousBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
    }
    if (previousTrustBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = previousTrustBundledPluginsDir;
    }
  });

  it("returns forced fallback assignments from the active gateway snapshot", async () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "extensions";
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    const config = {
      tools: {
        web: {
          search: { enabled: false, provider: "brave" },
          fetch: { provider: "firecrawl" },
        },
      },
      plugins: {
        entries: {
          firecrawl: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "FIRECRAWL_API_KEY",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        FIRECRAWL_API_KEY: "gateway-only-firecrawl-key",
        HOME: process.env.HOME,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });
    activateSecretsRuntimeSnapshot(snapshot);

    const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web fetch",
      targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
      forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    });

    expect(resolved.assignments).toMatchObject([
      {
        path: "plugins.entries.firecrawl.config.webSearch.apiKey",
        value: "gateway-only-firecrawl-key",
      },
    ]);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.inactiveRefPaths).toEqual([]);
  });

  it("re-resolves forced command-selected web provider paths with gateway env", async () => {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "extensions";
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    const firecrawlPath = "plugins.entries.firecrawl.config.webSearch.apiKey";
    const config = {
      tools: {
        web: {
          search: { enabled: true, provider: "exa" },
        },
      },
      plugins: {
        entries: {
          firecrawl: {
            enabled: false,
            config: {
              webSearch: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "FIRECRAWL_API_KEY",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env: {
        FIRECRAWL_API_KEY: "gateway-selected-firecrawl-key",
        HOME: process.env.HOME,
        OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      },
    });
    activateSecretsRuntimeSnapshot(snapshot);

    const resolved = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([firecrawlPath]),
      allowedPaths: new Set([firecrawlPath]),
      forcedActivePaths: new Set([firecrawlPath]),
    });

    expect(resolved.assignments).toMatchObject([
      {
        path: firecrawlPath,
        value: "gateway-selected-firecrawl-key",
      },
    ]);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.inactiveRefPaths).toEqual([]);
  });
});
