import { describe, expect, it } from "vitest";
import { resolveCommandSecretsFromActiveRuntimeSnapshot } from "./runtime-command-secrets.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("resolveCommandSecretsFromActiveRuntimeSnapshot", () => {
  it("reruns web secret resolution for provider overrides", async () => {
    const googlePath = "plugins.entries.google.config.webSearch.apiKey";
    const bravePath = "plugins.entries.brave.config.webSearch.apiKey";
    const config = asConfig({
      tools: { web: { search: { provider: "gemini", enabled: true } } },
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
              },
            },
          },
          brave: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
              },
            },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      GEMINI_API_KEY: "gemini-live",
      BRAVE_API_KEY: "brave-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });
    const googleConfig = snapshot.config.plugins?.entries?.google?.config as
      | { webSearch?: { apiKey?: unknown } }
      | undefined;
    const braveConfig = snapshot.config.plugins?.entries?.brave?.config as
      | { webSearch?: { apiKey?: unknown } }
      | undefined;
    expect(googleConfig?.webSearch?.apiKey).toBe("gemini-live");
    expect(braveConfig?.webSearch?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "BRAVE_API_KEY",
    });

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([googlePath, bravePath]),
      providerOverrides: { webSearch: "brave" },
    });

    expect(result.assignments).toEqual([
      {
        path: bravePath,
        pathSegments: bravePath.split("."),
        value: "brave-live",
      },
    ]);
    expect(result.inactiveRefPaths).toContain(googlePath);
  });

  it("returns legacy web fetch assignments for provider overrides", async () => {
    const legacyPath = "tools.web.fetch.firecrawl.apiKey";
    const config = asConfig({
      tools: {
        web: {
          fetch: {
            provider: "browser",
            firecrawl: {
              apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
            },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      FIRECRAWL_API_KEY: "firecrawl-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });
    const fetchConfig = snapshot.config.tools?.web?.fetch as
      | { firecrawl?: { apiKey?: unknown } }
      | undefined;
    expect(fetchConfig?.firecrawl?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "FIRECRAWL_API_KEY",
    });

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web fetch",
      targetIds: new Set([legacyPath]),
      providerOverrides: { webFetch: "firecrawl" },
    });

    expect(result.assignments).toEqual([
      {
        path: legacyPath,
        pathSegments: legacyPath.split("."),
        value: "firecrawl-live",
      },
    ]);
  });

  it("returns legacy web fetch assignments for the configured provider", async () => {
    const legacyPath = "tools.web.fetch.firecrawl.apiKey";
    const config = asConfig({
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
            firecrawl: {
              apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
            },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      FIRECRAWL_API_KEY: "firecrawl-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web fetch",
      targetIds: new Set([legacyPath]),
    });

    expect(result.assignments).toEqual([
      {
        path: legacyPath,
        pathSegments: legacyPath.split("."),
        value: "firecrawl-live",
      },
    ]);
  });

  it("keeps legacy shared web search refs inactive for plugin-scoped provider overrides", async () => {
    const sharedPath = "tools.web.search.apiKey";
    const googlePath = "plugins.entries.google.config.webSearch.apiKey";
    const config = asConfig({
      tools: {
        web: {
          search: {
            provider: "brave",
            apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
          },
        },
      },
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
              },
            },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      BRAVE_API_KEY: "brave-live",
      GEMINI_API_KEY: "gemini-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });
    const resolvedSearchConfig = snapshot.config.tools?.web?.search as { apiKey?: unknown };
    resolvedSearchConfig.apiKey = "brave-live";

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([sharedPath, googlePath]),
      providerOverrides: { webSearch: "gemini" },
    });

    expect(result.assignments).toEqual([
      {
        path: googlePath,
        pathSegments: googlePath.split("."),
        value: "gemini-live",
      },
    ]);
    expect(result.inactiveRefPaths).toContain(sharedPath);
  });

  it("keeps provider override refs inactive when the web search surface is disabled", async () => {
    const googlePath = "plugins.entries.google.config.webSearch.apiKey";
    const config = asConfig({
      tools: { web: { search: { enabled: false, provider: "brave" } } },
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
              },
            },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      GEMINI_API_KEY: "gemini-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([googlePath]),
      providerOverrides: { webSearch: "gemini" },
    });

    expect(result.assignments).toEqual([]);
    expect(result.inactiveRefPaths).toContain(googlePath);
  });

  it("returns legacy shared web search assignments for providers that read the shared key", async () => {
    const sharedPath = "tools.web.search.apiKey";
    const config = asConfig({
      tools: {
        web: {
          search: {
            provider: "gemini",
            apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
          },
        },
      },
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
              },
            },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      BRAVE_API_KEY: "brave-live",
      GEMINI_API_KEY: "gemini-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([sharedPath]),
      providerOverrides: { webSearch: "brave" },
    });

    expect(result.assignments).toEqual([
      {
        path: sharedPath,
        pathSegments: sharedPath.split("."),
        value: "brave-live",
      },
    ]);
  });

  it("returns shared web search assignments for selected top-level credential providers", async () => {
    const sharedPath = "tools.web.search.apiKey";
    const config = asConfig({
      tools: {
        web: {
          search: {
            provider: "gemini",
            apiKey: { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      MINIMAX_API_KEY: "minimax-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set([sharedPath]),
      providerOverrides: { webSearch: "minimax" },
    });

    expect(result.assignments).toEqual([
      {
        path: sharedPath,
        pathSegments: sharedPath.split("."),
        value: "minimax-live",
      },
    ]);
  });

  it("preserves non-web snapshot assignments when provider overrides are present", async () => {
    const talkPath = "talk.providers.default.apiKey";
    const googlePath = "plugins.entries.google.config.webSearch.apiKey";
    const config = asConfig({
      talk: {
        providers: {
          default: {
            apiKey: { source: "env", provider: "default", id: "TALK_API_KEY" },
          },
        },
      },
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
              },
            },
          },
        },
      },
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      TALK_API_KEY: "talk-live",
      GEMINI_API_KEY: "gemini-live",
    };

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config,
      env,
      includeAuthStoreRefs: false,
    });
    expect(snapshot.config.talk?.providers?.default?.apiKey).toBe("talk-live");

    activateSecretsRuntimeSnapshot(snapshot);
    const result = await resolveCommandSecretsFromActiveRuntimeSnapshot({
      commandName: "infer web search",
      targetIds: new Set(["talk.providers.*.apiKey", googlePath]),
      providerOverrides: { webSearch: "gemini" },
    });

    expect(result.assignments).toEqual([
      {
        path: talkPath,
        pathSegments: talkPath.split("."),
        value: "talk-live",
      },
      {
        path: googlePath,
        pathSegments: googlePath.split("."),
        value: "gemini-live",
      },
    ]);
  });
});
