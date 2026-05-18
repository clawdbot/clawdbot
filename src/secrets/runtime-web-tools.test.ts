import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";

type ProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "duckduckgo";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

const { resolvePluginWebFetchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebFetchProvidersMock: vi.fn(() => buildTestWebFetchProviders()),
}));
const {
  resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock,
} = vi.hoisted(() => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock: vi.fn(() =>
    buildTestWebSearchProviders(),
  ),
  resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock: vi.fn(() =>
    buildTestWebFetchProviders(),
  ),
}));
const {
  resolveBundledWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledWebFetchProvidersFromPublicArtifactsMock,
} = vi.hoisted(() => ({
  resolveBundledWebSearchProvidersFromPublicArtifactsMock: vi.fn(() =>
    buildTestWebSearchProviders(),
  ),
  resolveBundledWebFetchProvidersFromPublicArtifactsMock: vi.fn(() => buildTestWebFetchProviders()),
}));
const {
  resolveManifestContractPluginIdsMock,
  resolveManifestContractPluginIdsByCompatibilityRuntimePathMock,
  resolveManifestContractOwnerPluginIdMock,
} = vi.hoisted(() => ({
  resolveManifestContractPluginIdsMock: vi.fn(() => [
    "brave",
    "duckduckgo",
    "google",
    "moonshot",
    "perplexity",
    "xai",
  ]),
  resolveManifestContractPluginIdsByCompatibilityRuntimePathMock: vi.fn(() => ["brave"]),
  resolveManifestContractOwnerPluginIdMock: vi.fn(
    ({ value }: { value: string }) =>
      (
        ({
          brave: "brave",
          firecrawl: "firecrawl",
          gemini: "google",
          grok: "xai",
          kimi: "moonshot",
          perplexity: "perplexity",
        }) as Record<string, string | undefined>
      )[value],
  ),
}));
const { loadInstalledPluginIndexInstallRecordsSyncMock } = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecordsSyncMock: vi.fn(() => ({})),
}));
let secretResolve: typeof import("./resolve.js");
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;
let restoreResolveSecretRefValuesSpy: (() => void) | undefined;

vi.mock("./runtime-web-tools-fallback.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-web-tools-fallback.runtime.js")>(
    "./runtime-web-tools-fallback.runtime.js",
  );
  return {
    ...actual,
    runtimeWebToolsFallbackProviders: {
      ...actual.runtimeWebToolsFallbackProviders,
      resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
      resolvePluginWebFetchProviders: resolvePluginWebFetchProvidersMock,
    },
  };
});

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts:
    resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts:
    resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock,
}));

vi.mock("./runtime-web-tools-public-artifacts.runtime.js", () => ({
  resolveBundledWebSearchProvidersFromPublicArtifacts:
    resolveBundledWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledWebFetchProvidersFromPublicArtifacts:
    resolveBundledWebFetchProvidersFromPublicArtifactsMock,
}));

vi.mock("./runtime-web-tools-manifest.runtime.js", () => ({
  resolveManifestContractPluginIds: resolveManifestContractPluginIdsMock,
  resolveManifestContractOwnerPluginId: resolveManifestContractOwnerPluginIdMock,
  resolveManifestContractPluginIdsByCompatibilityRuntimePath:
    resolveManifestContractPluginIdsByCompatibilityRuntimePathMock,
}));

vi.mock("../plugins/installed-plugin-index-records.js", async () => {
  const actual = await vi.importActual<
    typeof import("../plugins/installed-plugin-index-records.js")
  >("../plugins/installed-plugin-index-records.js");
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecordsSync: loadInstalledPluginIndexInstallRecordsSyncMock,
  };
});

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function providerPluginId(provider: ProviderUnderTest): string {
  switch (provider) {
    case "duckduckgo":
      return "duckduckgo";
    case "gemini":
      return "google";
    case "grok":
      return "xai";
    case "kimi":
      return "moonshot";
    default:
      return provider;
  }
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function setConfiguredProviderKey(
  configTarget: OpenClawConfig,
  pluginId: string,
  value: unknown,
): void {
  const plugins = ensureRecord(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const pluginEntry = ensureRecord(entries, pluginId);
  const config = ensureRecord(pluginEntry, "config");
  const webSearch = ensureRecord(config, "webSearch");
  webSearch.apiKey = value;
}

function setConfiguredFetchProviderKey(configTarget: OpenClawConfig, value: unknown): void {
  const plugins = ensureRecord(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const pluginEntry = ensureRecord(entries, "firecrawl");
  const config = ensureRecord(pluginEntry, "config");
  const webFetch = ensureRecord(config, "webFetch");
  webFetch.apiKey = value;
}

function createTestProvider(params: {
  provider: ProviderUnderTest;
  pluginId: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  return {
    pluginId: params.pluginId,
    id: params.provider,
    label: params.provider,
    hint: `${params.provider} test provider`,
    requiresCredential: params.provider === "duckduckgo" ? false : undefined,
    envVars: params.provider === "duckduckgo" ? [] : [`${params.provider.toUpperCase()}_API_KEY`],
    placeholder: params.provider === "duckduckgo" ? "(no key needed)" : `${params.provider}-...`,
    signupUrl: `https://example.com/${params.provider}`,
    autoDetectOrder: params.order,
    credentialPath: params.provider === "duckduckgo" ? "" : credentialPath,
    inactiveSecretPaths: params.provider === "duckduckgo" ? [] : [credentialPath],
    getCredentialValue: (searchConfig) =>
      params.provider === "duckduckgo" ? "duckduckgo-no-key-needed" : searchConfig?.apiKey,
    setCredentialValue: (searchConfigTarget, value) => {
      searchConfigTarget.apiKey = value;
    },
    getConfiguredCredentialValue: (config) => {
      const entryConfig = config?.plugins?.entries?.[params.pluginId]?.config;
      const configuredValue =
        entryConfig && typeof entryConfig === "object"
          ? (entryConfig as { webSearch?: { apiKey?: unknown } }).webSearch?.apiKey
          : undefined;
      if (configuredValue !== undefined || params.provider !== "brave") {
        return configuredValue;
      }
      const search = config?.tools?.web?.search;
      return search && typeof search === "object"
        ? (search as { apiKey?: unknown }).apiKey
        : undefined;
    },
    getConfiguredCredentialFallback: (config) => {
      if (params.provider === "brave") {
        const search = config?.tools?.web?.search;
        return search && typeof search === "object" && "apiKey" in search
          ? {
              path: "tools.web.search.apiKey",
              value: (search as { apiKey?: unknown }).apiKey,
            }
          : undefined;
      }
      if (params.provider === "gemini") {
        const provider = config?.models?.providers?.google;
        return provider && typeof provider === "object" && "apiKey" in provider
          ? {
              path: "models.providers.google.apiKey",
              value: (provider as { apiKey?: unknown }).apiKey,
            }
          : undefined;
      }
      return undefined;
    },
    setConfiguredCredentialValue: (configTarget, value) => {
      setConfiguredProviderKey(configTarget, params.pluginId, value);
    },
    resolveRuntimeMetadata:
      params.provider === "perplexity"
        ? () => ({
            perplexityTransport: "search_api" as const,
          })
        : undefined,
    createTool: () => null,
  };
}

function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return [
    createTestProvider({ provider: "brave", pluginId: "brave", order: 10 }),
    createTestProvider({ provider: "gemini", pluginId: "google", order: 20 }),
    createTestProvider({ provider: "grok", pluginId: "xai", order: 30 }),
    createTestProvider({ provider: "kimi", pluginId: "moonshot", order: 40 }),
    createTestProvider({ provider: "perplexity", pluginId: "perplexity", order: 50 }),
    createTestProvider({ provider: "duckduckgo", pluginId: "duckduckgo", order: 100 }),
  ];
}

function buildTestWebFetchProviders(): PluginWebFetchProviderEntry[] {
  return [
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      label: "firecrawl",
      hint: "firecrawl test provider",
      envVars: ["FIRECRAWL_API_KEY"],
      placeholder: "fc-...",
      signupUrl: "https://example.com/firecrawl",
      autoDetectOrder: 50,
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      inactiveSecretPaths: ["plugins.entries.firecrawl.config.webFetch.apiKey"],
      getCredentialValue: (fetchConfig) => fetchConfig?.apiKey,
      setCredentialValue: (fetchConfigTarget, value) => {
        fetchConfigTarget.apiKey = value;
      },
      getConfiguredCredentialValue: (config) => {
        const entryConfig = config?.plugins?.entries?.firecrawl?.config;
        return entryConfig && typeof entryConfig === "object"
          ? (entryConfig as { webFetch?: { apiKey?: unknown } }).webFetch?.apiKey
          : undefined;
      },
      getConfiguredCredentialFallback: (config) => {
        const entryConfig = config?.plugins?.entries?.firecrawl?.config;
        const apiKey =
          entryConfig && typeof entryConfig === "object"
            ? (entryConfig as { webSearch?: { apiKey?: unknown } }).webSearch?.apiKey
            : undefined;
        return apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: apiKey,
            };
      },
      setConfiguredCredentialValue: (configTarget, value) => {
        setConfiguredFetchProviderKey(configTarget, value);
      },
      createTool: () => null,
    },
  ];
}

async function runRuntimeWebTools(params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv }) {
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: params.env ?? {},
  });
  const metadata = await resolveRuntimeWebTools({
    sourceConfig,
    resolvedConfig,
    context,
  });
  return { metadata, resolvedConfig, context };
}

function createProviderSecretRefConfig(
  provider: ProviderUnderTest,
  envRefId: string,
): OpenClawConfig {
  return asConfig({
    tools: {
      web: {
        search: {
          enabled: true,
          provider,
        },
      },
    },
    plugins: {
      entries: {
        [providerPluginId(provider)]: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: { source: "env", provider: "default", id: envRefId },
            },
          },
        },
      },
    },
  });
}

function readProviderKey(config: OpenClawConfig, provider: ProviderUnderTest): unknown {
  const pluginConfig = config.plugins?.entries?.[providerPluginId(provider)]?.config as
    | { webSearch?: { apiKey?: unknown } }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function diagnostics(value: unknown) {
  expect(Array.isArray(value), "diagnostics").toBe(true);
  return value as Array<Record<string, unknown>>;
}

function expectDiagnostic(
  value: unknown,
  fields: { code: string; path?: string; messageIncludes?: string },
) {
  const diagnostic = diagnostics(value).find(
    (candidate) =>
      candidate.code === fields.code &&
      (fields.path === undefined || candidate.path === fields.path),
  );
  if (!diagnostic) {
    throw new Error(`Expected diagnostic ${fields.code}${fields.path ? ` ${fields.path}` : ""}`);
  }
  if (fields.messageIncludes) {
    expect(typeof diagnostic.message).toBe("string");
    expect(diagnostic.message).toContain(fields.messageIncludes);
  }
}

function expectNoDiagnosticCode(value: unknown, code: string) {
  expect(diagnostics(value).some((diagnostic) => diagnostic.code === code)).toBe(false);
}

function firstMockArg(source: { mock: { calls: Array<Array<unknown>> } }) {
  const call = source.mock.calls[0];
  if (!call) {
    throw new Error("expected mock call options");
  }
  return requireRecord(call[0], "mock call options");
}

describe("runtime web tools resolution", () => {
  beforeAll(async () => {
    secretResolve = await import("./resolve.js");
    ({ createResolverContext } = await import("./runtime-shared.js"));
    ({ resolveRuntimeWebTools } = await import("./runtime-web-tools.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockClear();
    resolvePluginWebFetchProvidersMock.mockClear();
    resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledWebSearchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledWebFetchProvidersFromPublicArtifactsMock.mockClear();
    resolveManifestContractOwnerPluginIdMock.mockClear();
    resolveManifestContractPluginIdsMock.mockClear();
    resolveManifestContractPluginIdsByCompatibilityRuntimePathMock.mockClear();
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReset();
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({});
  });

  afterEach(() => {
    restoreResolveSecretRefValuesSpy?.();
    restoreResolveSecretRefValuesSpy = undefined;
  });

  it("keeps web search inactive when only web fetch is configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY_REF" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("keeps web fetch inactive when only web search is configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "XAI_API_KEY_REF" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "grok",
            },
          },
        },
      }),
      env: {
        XAI_API_KEY_REF: "xai-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("grok");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.providerSource).toBe("none");
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("skips fetch provider discovery when web fetch only configures runtime limits", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
              maxChars: 200_000,
              maxCharsCap: 2_000_000,
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [],
          entries: {},
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key-should-not-resolve", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("skips fetch provider discovery when web fetch is explicitly disabled", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: false,
              provider: "firecrawl",
            },
          },
        },
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
                },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key-should-not-resolve", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("keeps active fetch provider SecretRefs on the discovery path", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
                },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.providerSource).toBe("configured");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["firecrawl"],
    });
  });

  it("auto-selects a keyless provider when no credentials are configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
    });

    expect(metadata.search.selectedProvider).toBe("duckduckgo");
    expect(metadata.search.providerSource).toBe("auto-detect");
    expectDiagnostic(metadata.search.diagnostics, {
      code: "WEB_SEARCH_AUTODETECT_SELECTED",
      messageIncludes: 'keyless provider "duckduckgo"',
    });
  });

  it.each([
    {
      provider: "brave" as const,
      envRefId: "BRAVE_PROVIDER_REF",
      resolvedKey: "brave-provider-key",
    },
    {
      provider: "gemini" as const,
      envRefId: "GEMINI_PROVIDER_REF",
      resolvedKey: "gemini-provider-key",
    },
    {
      provider: "grok" as const,
      envRefId: "GROK_PROVIDER_REF",
      resolvedKey: "grok-provider-key",
    },
    {
      provider: "kimi" as const,
      envRefId: "KIMI_PROVIDER_REF",
      resolvedKey: "kimi-provider-key",
    },
    {
      provider: "perplexity" as const,
      envRefId: "PERPLEXITY_PROVIDER_REF",
      resolvedKey: "pplx-provider-key",
    },
  ])(
    "resolves configured provider SecretRef for $provider",
    async ({ provider, envRefId, resolvedKey }) => {
      const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
        config: createProviderSecretRefConfig(provider, envRefId),
        env: {
          [envRefId]: resolvedKey,
        },
      });

      expect(metadata.search.providerConfigured).toBe(provider);
      expect(metadata.search.providerSource).toBe("configured");
      expect(metadata.search.selectedProvider).toBe(provider);
      expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
      expect(readProviderKey(resolvedConfig, provider)).toBe(resolvedKey);
      expect(context.warnings.map((warning) => warning.code)).not.toContain(
        "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      );
      if (provider === "perplexity") {
        expect(metadata.search.perplexityTransport).toBe("search_api");
      }
    },
  );

  it("resolves selected provider SecretRef even when provider config is disabled", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  enabled: false,
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref",
      },
    });

    expect(metadata.search.providerConfigured).toBe("gemini");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("web-search-gemini-ref");
    expect(context.warnings.map((warning) => warning.path)).not.toContain(
      "plugins.entries.google.config.webSearch.apiKey",
    );
  });

  it("auto-detects provider precedence across all configured providers", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "BRAVE_REF" } },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "GEMINI_REF" } },
              },
            },
            xai: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "GROK_REF" } },
              },
            },
            moonshot: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "KIMI_REF" } },
              },
            },
            perplexity: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "PERPLEXITY_REF" } },
              },
            },
          },
        },
      }),
      env: {
        BRAVE_REF: "brave-precedence-key",
        GEMINI_REF: "gemini-precedence-key",
        GROK_REF: "grok-precedence-key",
        KIMI_REF: "kimi-precedence-key",
        PERPLEXITY_REF: "pplx-precedence-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-precedence-key");
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.xai.config.webSearch.apiKey",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.moonshot.config.webSearch.apiKey",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.perplexity.config.webSearch.apiKey",
    });
  });

  it("auto-detects first available provider and keeps lower-priority refs inactive", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY_REF" },
                },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_GEMINI_API_KEY_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY_REF: "brave-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-runtime-key");
    expect(readProviderKey(resolvedConfig, "gemini")).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_GEMINI_API_KEY_REF",
    });
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("auto-detects the next provider when a higher-priority ref is unresolved", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_BRAVE_API_KEY_REF" },
                },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-runtime-key");
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.brave.config.webSearch.apiKey",
    });
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("auto-detects Gemini from the Google model provider key after env fallbacks", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        models: {
          providers: {
            google: {
              apiKey: "google-provider-runtime-key",
            },
          },
        },
      }),
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(metadata.search.selectedProviderKeySource).toBe("config");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("google-provider-runtime-key");
  });

  it("prefers GEMINI_API_KEY over the Google model provider key", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        models: {
          providers: {
            google: {
              apiKey: "google-provider-runtime-key",
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY: "gemini-env-runtime-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(metadata.search.selectedProviderKeySource).toBe("env");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-env-runtime-key");
  });

  it("does not mirror provider env fallback over configured fallback SecretRefs", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        models: {
          providers: {
            google: {
              apiKey: { source: "env", provider: "default", id: "GOOGLE_PROVIDER_REF" },
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY: "gemini-env-runtime-key",
        GOOGLE_PROVIDER_REF: "google-provider-ref-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(metadata.search.selectedProviderKeySource).toBe("env");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-env-runtime-key");
    expect(resolvedConfig.models?.providers?.google?.apiKey).toBe("google-provider-ref-key");
  });

  it("warns when provider is invalid and falls back to auto-detect", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "invalid-provider",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerConfigured).toBeUndefined();
    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-runtime-key");
    expectDiagnostic(metadata.search.diagnostics, {
      code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      path: "tools.web.search.provider",
    });
    expectDiagnostic(context.warnings, {
      code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
      path: "tools.web.search.provider",
    });
  });

  it("fails fast when configured provider ref is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      tools: {
        web: {
          search: {
            provider: "gemini",
          },
        },
      },
      plugins: {
        entries: {
          google: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "MISSING_GEMINI_API_KEY_REF" },
              },
            },
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {},
    });

    await expect(
      resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      }),
    ).rejects.toThrow("[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]");
    expectDiagnostic(context.warnings, {
      code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
  });

  it("uses bundled-only runtime provider resolution for configured bundled providers", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GEMINI_PROVIDER_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        GEMINI_PROVIDER_REF: "gemini-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["google"],
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses exact plugin-id hints for configured bundled provider entries without manifest owner lookup", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "BRAVE_PROVIDER_REF" },
                },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GOOGLE_PROVIDER_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        BRAVE_PROVIDER_REF: "brave-provider-key",
        GOOGLE_PROVIDER_REF: "google-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["brave"],
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses single plugin-scoped web search config as a bundled provider hint", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GOOGLE_PROVIDER_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        GOOGLE_PROVIDER_REF: "google-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["google"],
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("auto-detects Brave from legacy top-level web search apiKey", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              apiKey: { source: "env", provider: "default", id: "LEGACY_WEB_SEARCH_REF" },
            },
          },
        },
      }),
      env: {
        LEGACY_WEB_SEARCH_REF: "legacy-web-search-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("legacy-web-search-key");
    expect(resolveManifestContractPluginIdsByCompatibilityRuntimePathMock).not.toHaveBeenCalled();
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("prefers legacy top-level web search apiKey over provider env fallback", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              apiKey: { source: "env", provider: "default", id: "LEGACY_WEB_SEARCH_REF" },
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "ambient-brave-key",
        LEGACY_WEB_SEARCH_REF: "legacy-web-search-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("legacy-web-search-key");
  });

  it("does not resolve web fetch provider SecretRef when web fetch is inactive", async () => {
    const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
    restoreResolveSecretRefValuesSpy = () => resolveSpy.mockRestore();
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_REF" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              enabled: false,
              provider: "firecrawl",
            },
          },
        },
      }),
    });

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.selectedProviderKeySource).toBeUndefined();
    expect(context.warnings).toStrictEqual([]);
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("keeps configured provider metadata and inactive warnings when search is disabled", async () => {
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GEMINI_PROVIDER_REF" },
                },
              },
            },
          },
        },
      }),
    });

    expect(metadata.search.providerConfigured).toBe("gemini");
    expect(metadata.search.providerSource).toBe("configured");
    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
  });

  it("emits inactive warnings for configured and lower-priority web-search providers when search is disabled", async () => {
    const { context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: false,
              apiKey: { source: "env", provider: "default", id: "DISABLED_WEB_SEARCH_API_KEY" },
            },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "DISABLED_WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
    });

    expectDiagnostic(context.warnings, {
      code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      path: "plugins.entries.google.config.webSearch.apiKey",
    });
  });

  it("does not auto-enable search when tools.web.search is absent", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({}),
    });

    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.search.selectedProvider).toBeUndefined();
  });

  it("skips provider discovery when no web surfaces are configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({}),
    });

    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.providerSource).toBe("none");
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses bundled public artifacts for bundled web search provider discovery", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "brave-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses runtime web search discovery when the managed plugin index install records is populated", async () => {
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      "external-search": {
        source: "npm",
        spec: "@openclaw/external-search",
      },
    });

    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "brave-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(firstMockArg(resolvePluginWebSearchProvidersMock).bundledAllowlistCompat).toBe(true);
  });

  it("uses bundled public artifacts for bundled web fetch provider discovery", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses runtime web fetch discovery when the managed plugin index install records is populated", async () => {
    loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
      "external-fetch": {
        source: "npm",
        spec: "@openclaw/external-fetch",
      },
    });

    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: "firecrawl-config-key",
                },
              },
            },
          },
        },
      }),
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(firstMockArg(resolvePluginWebFetchProvidersMock).bundledAllowlistCompat).toBe(true);
  });

  it("uses env fallback for unresolved web fetch provider SecretRef when active", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_REF" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-fallback-key", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-fallback-key");
    expectDiagnostic(context.warnings, {
      code: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED",
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
    });
  });

  it("resolves web fetch fallback SecretRefs with provider env var allowlist", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-search-ref-key",
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-search-ref-key");
  });

  it("resolves plugin-owned web fetch SecretRefs without tools.web.fetch", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
                },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key",
      },
    });

    expect(metadata.fetch.providerSource).toBe("auto-detect");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("secretRef");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-runtime-key");
  });

  it("resolves legacy Firecrawl web fetch SecretRefs through the plugin-owned path", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              firecrawl: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-legacy-key",
      },
    });

    expect(metadata.fetch.providerSource).toBe("auto-detect");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-legacy-key");
  });

  it("fails fast when active web fetch provider SecretRef is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_REF" },
              },
            },
          },
        },
      },
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {},
    });

    await expect(
      resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      }),
    ).rejects.toThrow("[WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK]");
    expectDiagnostic(context.warnings, {
      code: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
    });
  });

  it("rejects env SecretRefs for web fetch provider keys outside provider allowlists", async () => {
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: { source: "env", provider: "default", id: "AWS_SECRET_ACCESS_KEY" },
              },
            },
          },
        },
      },
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        AWS_SECRET_ACCESS_KEY: "not-allowed",
      },
    });

    await expect(
      resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      }),
    ).rejects.toThrow("[WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK]");
    expectDiagnostic(context.warnings, {
      code: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
      path: "plugins.entries.firecrawl.config.webFetch.apiKey",
      messageIncludes: 'SecretRef env var "AWS_SECRET_ACCESS_KEY" is not allowed.',
    });
  });

  it("keeps web fetch provider discovery bundled-only during runtime secret resolution", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          load: {
            paths: ["/tmp/malicious-plugin"],
          },
          entries: {
            firecrawl: {
              enabled: true,
              config: {
                webFetch: {
                  apiKey: "firecrawl-config-key",
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["firecrawl"],
    });
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  describe("when brave is installed as an external plugin and explicitly configured", () => {
    const externalBraveImpl = ({
      value,
      origin,
    }: {
      value: string;
      origin?: string;
    }): string | undefined => {
      if (origin === "bundled" && value === "brave") {
        return undefined;
      }
      return (
        {
          brave: "brave",
          firecrawl: "firecrawl",
          gemini: "google",
          grok: "xai",
          kimi: "moonshot",
          perplexity: "perplexity",
        } as Record<string, string | undefined>
      )[value];
    };

    const defaultImpl = ({ value }: { value: string }): string | undefined =>
      (
        ({
          brave: "brave",
          firecrawl: "firecrawl",
          gemini: "google",
          grok: "xai",
          kimi: "moonshot",
          perplexity: "perplexity",
        }) as Record<string, string | undefined>
      )[value];

    beforeEach(() => {
      loadInstalledPluginIndexInstallRecordsSyncMock.mockReturnValue({
        brave: { source: "npm", spec: "@openclaw/brave-search" },
      });
      resolveManifestContractOwnerPluginIdMock.mockImplementation(externalBraveImpl);
    });

    afterEach(() => {
      resolveManifestContractOwnerPluginIdMock.mockImplementation(defaultImpl);
    });

    it("selects the configured provider without re-invoking provider discovery when found in the first pass", async () => {
      resolvePluginWebSearchProvidersMock
        .mockReturnValueOnce(buildTestWebSearchProviders())
        .mockReturnValueOnce([]);

      const { metadata, context } = await runRuntimeWebTools({
        config: asConfig({
          tools: {
            web: {
              search: {
                provider: "brave",
              },
            },
          },
          plugins: {
            entries: {
              brave: {
                config: {
                  webSearch: {
                    apiKey: "brave-api-key", // pragma: allowlist secret
                  },
                },
              },
            },
          },
        }),
      });

      expect(metadata.search.selectedProvider).toBe("brave");
      expect(metadata.search.providerSource).toBe("configured");
      expect(metadata.search.selectedProviderKeySource).toBe("config");
      expectNoDiagnosticCode(context.warnings, "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT");
      expect(resolvePluginWebSearchProvidersMock).toHaveBeenCalledTimes(1);
      expect(
        resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
      ).not.toHaveBeenCalled();
      expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    });
  });
});
