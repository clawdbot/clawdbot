/** Unit tests for standalone-tool credential resolution boundary. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretRef } from "../config/types.secrets.js";
import { createResolverContext } from "./runtime-shared.js";
import type {
  RuntimeWebProviderMetadataBase,
  RuntimeWebProviderSelectionParams,
  RuntimeWebUnavailableProvider,
  SecretResolutionResult,
} from "./runtime-web-tools-selection.types.js";
import {
  resolveMissingStandaloneProviderCredentials,
  resolveStandaloneProviderCredentials,
} from "./runtime-web-tools-standalone.js";

type TestProvider = {
  id: string;
  pluginId: string;
  requiresCredential?: boolean;
  credentialPath: string;
  inactivePaths?: string[];
  envVar: string;
};

type TestSource = "secretRef" | "env";

type TestMetadata = RuntimeWebProviderMetadataBase<TestSource>;

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function hasConfiguredSecretRef(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    (value as { source: string }).source === "env"
  );
}

function buildSelection(params: {
  providers: TestProvider[];
  standaloneToolProviderIds?: Set<string>;
  configuredProvider?: string;
  resolvedConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
}): RuntimeWebProviderSelectionParams<TestProvider, undefined, TestSource, TestMetadata> {
  const sourceConfig = params.sourceConfig ?? asConfig({});
  const resolvedConfig = params.resolvedConfig ?? asConfig({});
  const metadata: TestMetadata = {
    providerSource: "none",
    diagnostics: [],
  };
  const context = createResolverContext({ sourceConfig, env: {} });

  return {
    scopePath: "tools.web.search",
    toolConfig: undefined,
    enabled: true,
    providers: params.providers,
    configuredProvider: params.configuredProvider,
    metadata,
    diagnostics: [],
    sourceConfig,
    resolvedConfig,
    context,
    defaults: undefined,
    allowKeylessAutoSelect: false,
    deferKeylessFallback: true,
    standaloneToolProviderIds: params.standaloneToolProviderIds,
    noFallbackCode: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    autoDetectSelectedCode: "WEB_SEARCH_AUTODETECT_SELECTED",
    readConfiguredCredential: ({ provider, config }) => {
      const entryConfig = (
        config as {
          plugins?: { entries?: Record<string, { config?: { webSearch?: { apiKey?: unknown } } }> };
        }
      ).plugins?.entries?.[provider.pluginId]?.config;
      return entryConfig?.webSearch?.apiKey;
    },
    resolveSecretInput: async ({
      providerId,
      value,
    }): Promise<SecretResolutionResult<TestSource>> => {
      const ref = hasConfiguredSecretRef(value) ? (value as SecretRef) : undefined;
      if (ref) {
        const resolved = process.env[ref.id] ?? `${providerId}-resolved`;
        return {
          source: "env",
          secretRefConfigured: true,
          value: resolved,
          secretRef: ref,
          secretRefKey: `${ref.source}:${ref.provider}:${ref.id}`,
        };
      }
      return { source: "env", secretRefConfigured: false };
    },
    setResolvedCredential: ({ provider, value }) => {
      const plugins = (
        resolvedConfig as {
          plugins?: { entries?: Record<string, { config?: { webSearch?: { apiKey?: unknown } } }> };
        }
      ).plugins ?? { entries: {} };
      resolvedConfig.plugins = plugins;
      const entries = plugins.entries ?? {};
      plugins.entries = entries;
      const entry = entries[provider.pluginId] ?? { config: { webSearch: {} } };
      entries[provider.pluginId] = entry;
      const config = entry.config ?? { webSearch: {} };
      entry.config = config;
      const webSearch = config.webSearch ?? {};
      config.webSearch = webSearch;
      webSearch.apiKey = value;
    },
    inactivePathsForProvider: (provider) => provider.inactivePaths ?? [provider.credentialPath],
    hasConfiguredSecretRef,
  };
}

describe("runtime-web-tools-standalone", () => {
  beforeAll(async () => {
    await import("./runtime-web-tools-fallback.runtime.js");
  });

  it("resolves credentials only for enabled standalone-tool providers", async () => {
    const providers: TestProvider[] = [
      {
        id: "brave",
        pluginId: "brave",
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        envVar: "BRAVE_API_KEY",
      },
      {
        id: "perplexity",
        pluginId: "perplexity",
        credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
        envVar: "PERPLEXITY_API_KEY",
      },
      {
        id: "xai",
        pluginId: "xai",
        credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
        envVar: "XAI_API_KEY",
      },
    ];
    const resolvedConfig = asConfig({});
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: { apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" } },
            },
          },
          perplexity: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "PERPLEXITY_API_KEY" },
              },
            },
          },
          xai: {
            config: {
              webSearch: { apiKey: { source: "env", provider: "default", id: "XAI_API_KEY" } },
            },
          },
        },
      },
    });

    const selection = buildSelection({
      providers,
      configuredProvider: "brave",
      standaloneToolProviderIds: new Set(["perplexity"]),
      resolvedConfig,
      sourceConfig,
    });

    const owners = await resolveStandaloneProviderCredentials({
      selection,
      selectedProvider: "brave",
      unavailableProviders: [],
    });

    // Selected provider is handled by the primary selection path, not standalone resolution.
    expect(
      (
        resolvedConfig as {
          plugins?: { entries?: { brave?: { config?: { webSearch?: { apiKey?: unknown } } } } };
        }
      ).plugins?.entries?.brave?.config?.webSearch?.apiKey,
    ).toBeUndefined();
    // Enabled standalone-tool provider gets its credential resolved.
    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: { perplexity?: { config?: { webSearch?: { apiKey?: unknown } } } };
          };
        }
      ).plugins?.entries?.perplexity?.config?.webSearch?.apiKey,
    ).toBe("perplexity-resolved");
    // Provider not in standaloneToolProviderIds is ignored.
    expect(
      (
        resolvedConfig as {
          plugins?: { entries?: { xai?: { config?: { webSearch?: { apiKey?: unknown } } } } };
        }
      ).plugins?.entries?.xai?.config?.webSearch?.apiKey,
    ).toBeUndefined();
    // The resolved credential is registered as a runtime secret owner.
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      providerId: "perplexity",
      path: "plugins.entries.perplexity.config.webSearch.apiKey",
      resolvedValue: "perplexity-resolved",
    });
  });

  it("resolves every inactive credential path for an enabled standalone-tool provider", async () => {
    const provider: TestProvider = {
      id: "perplexity",
      pluginId: "perplexity",
      credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
      inactivePaths: [
        "plugins.entries.perplexity.config.webSearch.apiKey",
        "plugins.entries.perplexity.config.webSearch.legacyApiKey",
      ],
      envVar: "PERPLEXITY_API_KEY",
    };
    const resolvedConfig = asConfig({
      plugins: {
        entries: {
          perplexity: {
            config: {
              webSearch: {
                apiKey: "placeholder",
                legacyApiKey: "placeholder",
              },
            },
          },
        },
      },
    });
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          perplexity: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "PERPLEXITY_API_KEY" },
              },
            },
          },
        },
      },
    });

    const selection = buildSelection({
      providers: [provider],
      configuredProvider: "brave",
      standaloneToolProviderIds: new Set(["perplexity"]),
      resolvedConfig,
      sourceConfig,
    });

    await resolveStandaloneProviderCredentials({
      selection,
      selectedProvider: "brave",
      unavailableProviders: [],
    });

    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: { perplexity?: { config?: { webSearch?: { apiKey?: unknown } } } };
          };
        }
      ).plugins?.entries?.perplexity?.config?.webSearch?.apiKey,
    ).toBe("perplexity-resolved");
    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: { perplexity?: { config?: { webSearch?: { legacyApiKey?: unknown } } } };
          };
        }
      ).plugins?.entries?.perplexity?.config?.webSearch?.legacyApiKey,
    ).toBe("perplexity-resolved");
  });

  it("records every inactive path as unavailable when a standalone provider SecretRef cannot be resolved", async () => {
    const provider: TestProvider = {
      id: "perplexity",
      pluginId: "perplexity",
      credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
      inactivePaths: [
        "plugins.entries.perplexity.config.webSearch.apiKey",
        "plugins.entries.perplexity.config.webSearch.legacyApiKey",
      ],
      envVar: "PERPLEXITY_API_KEY",
    };
    const resolvedConfig = asConfig({});
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          perplexity: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "PERPLEXITY_API_KEY" },
              },
            },
          },
        },
      },
    });

    const baseSelection = buildSelection({
      providers: [provider],
      configuredProvider: "brave",
      standaloneToolProviderIds: new Set(["perplexity"]),
      resolvedConfig,
      sourceConfig,
    });
    const selection = {
      ...baseSelection,
      resolveSecretInput: async (): Promise<SecretResolutionResult<TestSource>> => ({
        source: "env",
        secretRefConfigured: true,
        value: undefined,
        unresolvedRefReason: "secret reference was not found",
        secretRef: { source: "env", provider: "default", id: "PERPLEXITY_API_KEY" },
        secretRefKey: "env:PERPLEXITY_API_KEY",
      }),
    };

    const unavailableProviders: RuntimeWebUnavailableProvider[] = [];
    const owners = await resolveStandaloneProviderCredentials({
      selection,
      selectedProvider: "brave",
      unavailableProviders,
    });

    expect(unavailableProviders).toHaveLength(2);
    expect(unavailableProviders[0]?.path).toBe(
      "plugins.entries.perplexity.config.webSearch.apiKey",
    );
    expect(unavailableProviders[1]?.path).toBe(
      "plugins.entries.perplexity.config.webSearch.legacyApiKey",
    );
    expect(unavailableProviders.every((p) => p.providerId === "perplexity")).toBe(true);
    expect(new Set(unavailableProviders.map((p) => p.refKey)).size).toBe(1);
    // Unresolved standalone providers are also returned as owners so the runtime snapshot
    // can track them for refresh/degradation.
    expect(owners).toHaveLength(2);
    expect(owners.map((owner) => owner.path)).toEqual([
      "plugins.entries.perplexity.config.webSearch.apiKey",
      "plugins.entries.perplexity.config.webSearch.legacyApiKey",
    ]);
  });

  it("resolveMissingStandaloneProviderCredentials loads only the requested plugin's providers", async () => {
    const braveProvider: TestProvider = {
      id: "brave",
      pluginId: "brave",
      credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
      envVar: "BRAVE_API_KEY",
    };
    const perplexityProvider: TestProvider = {
      id: "perplexity",
      pluginId: "perplexity",
      credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
      envVar: "PERPLEXITY_API_KEY",
    };
    const resolvedConfig = asConfig({});
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          perplexity: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "PERPLEXITY_API_KEY" },
              },
            },
          },
        },
      },
    });

    const resolveProviders = async (pluginId: string): Promise<TestProvider[]> => {
      if (pluginId === "perplexity") {
        return [perplexityProvider];
      }
      return [];
    };

    const selection = buildSelection({
      providers: [braveProvider],
      configuredProvider: "brave",
      resolvedConfig,
      sourceConfig,
    });

    await resolveMissingStandaloneProviderCredentials({
      selection,
      configuredProvider: "brave",
      missingStandalonePluginIds: new Set(["perplexity"]),
      resolveProviders,
      unavailableProviders: [],
    });

    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: { perplexity?: { config?: { webSearch?: { apiKey?: unknown } } } };
          };
        }
      ).plugins?.entries?.perplexity?.config?.webSearch?.apiKey,
    ).toBe("perplexity-resolved");
  });

  it("resolveMissingStandaloneProviderCredentials does not resolve providers for plugins outside the missing set", async () => {
    const resolvedConfig = asConfig({});
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          xai: {
            config: {
              webSearch: { apiKey: { source: "env", provider: "default", id: "XAI_API_KEY" } },
            },
          },
        },
      },
    });

    const resolveProviders = vi.fn(async (_pluginId: string): Promise<TestProvider[]> => []);

    const selection = buildSelection({
      providers: [],
      resolvedConfig,
      sourceConfig,
    });

    await resolveMissingStandaloneProviderCredentials({
      selection,
      missingStandalonePluginIds: new Set(["perplexity"]),
      resolveProviders,
      unavailableProviders: [],
    });

    expect(resolveProviders).toHaveBeenCalledTimes(1);
    expect(resolveProviders).toHaveBeenCalledWith("perplexity");
  });

  it("resolveMissingStandaloneProviderCredentials only resolves providers in mappedProviderIds", async () => {
    // A plugin that declares two providers, but only one is mapped in
    // standaloneWebSearchProviderOwners. The unmapped sibling must not
    // receive standalone credential resolution.
    const mappedProvider: TestProvider = {
      id: "tavily",
      pluginId: "tavily",
      credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
      envVar: "TAVILY_API_KEY",
    };
    const unmappedSibling: TestProvider = {
      id: "tavily-extract",
      pluginId: "tavily",
      credentialPath: "plugins.entries.tavily.config.webSearch.extractKey",
      envVar: "TAVILY_EXTRACT_KEY",
    };
    const resolvedConfig = asConfig({});
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
                extractKey: { source: "env", provider: "default", id: "TAVILY_EXTRACT_KEY" },
              },
            },
          },
        },
      },
    });

    const resolveProviders = async (_pluginId: string): Promise<TestProvider[]> => [
      mappedProvider,
      unmappedSibling,
    ];

    const selection = buildSelection({
      providers: [],
      resolvedConfig,
      sourceConfig,
    });

    await resolveMissingStandaloneProviderCredentials({
      selection,
      missingStandalonePluginIds: new Set(["tavily"]),
      mappedProviderIds: new Set(["tavily"]),
      resolveProviders,
      unavailableProviders: [],
    });

    // Only the mapped provider's credential is resolved.
    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: { tavily?: { config?: { webSearch?: { apiKey?: unknown } } } };
          };
        }
      ).plugins?.entries?.tavily?.config?.webSearch?.apiKey,
    ).toBe("tavily-resolved");
    // The unmapped sibling stays untouched.
    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: {
              tavily?: { config?: { webSearch?: { extractKey?: unknown } } };
            };
          };
        }
      ).plugins?.entries?.tavily?.config?.webSearch?.extractKey,
    ).toBeUndefined();
  });

  it("resolveStandaloneProviderCredentials resolves credentials when surface enabled is false", async () => {
    // Standalone-tool credential resolution must not depend on the generic
    // search/fetch surface enablement. When tools.web.search.enabled is false,
    // standalone tools (e.g., tavily_search) still register and need their
    // mapped credentials.
    const provider: TestProvider = {
      id: "tavily",
      pluginId: "tavily",
      credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
      envVar: "TAVILY_API_KEY",
    };
    const resolvedConfig = asConfig({});
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
              },
            },
          },
        },
      },
    });

    const baseSelection = buildSelection({
      providers: [provider],
      configuredProvider: "brave",
      standaloneToolProviderIds: new Set(["tavily"]),
      resolvedConfig,
      sourceConfig,
    });
    // Simulate a disabled generic search surface.
    const selection = { ...baseSelection, enabled: false };

    const owners = await resolveStandaloneProviderCredentials({
      selection,
      selectedProvider: "brave",
      unavailableProviders: [],
    });

    // Credential is resolved despite the surface being disabled.
    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: { tavily?: { config?: { webSearch?: { apiKey?: unknown } } } };
          };
        }
      ).plugins?.entries?.tavily?.config?.webSearch?.apiKey,
    ).toBe("tavily-resolved");
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      providerId: "tavily",
      resolvedValue: "tavily-resolved",
    });
  });

  it("resolveMissingStandaloneProviderCredentials resolves credentials when surface enabled is false", async () => {
    const provider: TestProvider = {
      id: "tavily",
      pluginId: "tavily",
      credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
      envVar: "TAVILY_API_KEY",
    };
    const resolvedConfig = asConfig({});
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "TAVILY_API_KEY" },
              },
            },
          },
        },
      },
    });

    const resolveProviders = async (_pluginId: string): Promise<TestProvider[]> => [provider];

    const baseSelection = buildSelection({
      providers: [],
      resolvedConfig,
      sourceConfig,
    });
    // Simulate a disabled generic search surface.
    const selection = { ...baseSelection, enabled: false };

    const owners = await resolveMissingStandaloneProviderCredentials({
      selection,
      missingStandalonePluginIds: new Set(["tavily"]),
      mappedProviderIds: new Set(["tavily"]),
      resolveProviders,
      unavailableProviders: [],
    });

    expect(
      (
        resolvedConfig as {
          plugins?: {
            entries?: { tavily?: { config?: { webSearch?: { apiKey?: unknown } } } };
          };
        }
      ).plugins?.entries?.tavily?.config?.webSearch?.apiKey,
    ).toBe("tavily-resolved");
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({
      providerId: "tavily",
      resolvedValue: "tavily-resolved",
    });
  });
});
