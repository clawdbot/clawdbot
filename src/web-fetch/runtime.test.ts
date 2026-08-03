/** Tests web_fetch runtime provider selection, credential discovery, and sandbox filtering. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginWebFetchProviderEntry } from "../plugins/types.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import { withEnv } from "../test-utils/env.js";
import {
  createWebFetchTestProvider,
  type WebFetchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebFetchConfig = {
  webFetch?: {
    apiKey?: unknown;
  };
};

const {
  getActivePluginRegistryVersionMock,
  resolvePluginWebFetchProvidersMock,
  resolveRuntimeWebFetchProvidersMock,
} = vi.hoisted(() => ({
  getActivePluginRegistryVersionMock: vi.fn(() => 1),
  resolvePluginWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
  resolveRuntimeWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return {
    ...actual,
    getActivePluginRegistryVersion: getActivePluginRegistryVersionMock,
  };
});

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: resolvePluginWebFetchProvidersMock,
  resolveRuntimeWebFetchProviders: resolveRuntimeWebFetchProvidersMock,
}));

function getFirecrawlApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
    | TestPluginWebFetchConfig
    | undefined;
  return pluginConfig?.webFetch?.apiKey;
}

function createFirecrawlProvider(
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "firecrawl",
    id: "firecrawl",
    credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
    autoDetectOrder: 1,
    ...overrides,
  });
}

function createThirdPartyFetchProvider(): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "third-party-fetch",
    id: "thirdparty",
    credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
    autoDetectOrder: 0,
    getConfiguredCredentialValue: () => "runtime-key",
  });
}

function createFirecrawlPluginConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        firecrawl: {
          enabled: true,
          config: {
            webFetch: {
              apiKey,
            },
          },
        },
      },
    },
  };
}

type ResolvedWebFetchDefinition = NonNullable<
  ReturnType<Awaited<typeof import("./runtime.js")>["resolveWebFetchDefinition"]>
>;

function requireResolvedWebFetch(
  resolved: ReturnType<Awaited<typeof import("./runtime.js")>["resolveWebFetchDefinition"]>,
): ResolvedWebFetchDefinition {
  if (!resolved) {
    throw new Error("expected resolved web fetch definition");
  }
  return resolved;
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;
  let clearWebFetchRuntimeCachesForTest: typeof import("./runtime.js").clearWebFetchRuntimeCachesForTest;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeAll(async () => {
    ({ clearWebFetchRuntimeCachesForTest, resolveWebFetchDefinition } =
      await import("./runtime.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    clearWebFetchRuntimeCachesForTest();
    getActivePluginRegistryVersionMock.mockReset();
    getActivePluginRegistryVersionMock.mockReturnValue(1);
    resolvePluginWebFetchProvidersMock.mockReset();
    resolveRuntimeWebFetchProvidersMock.mockReset();
    resolvePluginWebFetchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearWebFetchRuntimeCachesForTest();
  });

  it("does not auto-detect providers from plugin-owned env SecretRefs without runtime metadata", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: getFirecrawlApiKey,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const config = createFirecrawlPluginConfig({
      source: "env",
      provider: "default",
      id: "AWS_SECRET_ACCESS_KEY",
    });

    withEnv({ FIRECRAWL_API_KEY: "" }, () => {
      expect(resolveWebFetchDefinition({ config })).toBeNull();
    });
  });

  it("prefers the runtime-selected provider when metadata is available", async () => {
    const provider = createFirecrawlProvider({
      createTool: ({ runtimeMetadata }) => ({
        description: "firecrawl",
        parameters: {},
        execute: async (args) => ({
          ...args,
          provider: runtimeMetadata?.selectedProvider ?? "firecrawl",
        }),
      }),
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([provider]);

    const runtimeWebFetch: RuntimeWebFetchMetadata = {
      providerSource: "auto-detect",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "env",
      diagnostics: [],
    };

    const resolved = resolveWebFetchDefinition({
      config: {},
      runtimeWebFetch,
      preferRuntimeProviders: true,
    });

    const webFetch = requireResolvedWebFetch(resolved);
    expect(webFetch.provider.id).toBe("firecrawl");
    await expect(
      webFetch.definition.execute({
        url: "https://example.com",
        extractMode: "markdown",
        maxChars: 1000,
      }),
    ).resolves.toEqual({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 1000,
      provider: "firecrawl",
    });
  });

  it("auto-detects providers from provider-declared env vars", () => {
    const provider = createFirecrawlProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    withEnv({ FIRECRAWL_API_KEY: "firecrawl-env-key" }, () => {
      const resolved = resolveWebFetchDefinition({
        config: {},
      });

      expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
    });
  });

  it("uses an explicitly configured keyless provider without an API key", () => {
    const provider = createFirecrawlProvider({
      requiresCredential: false,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("does not auto-detect a keyless provider without a credential", () => {
    const provider = createFirecrawlProvider({
      requiresCredential: false,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    expect(resolveWebFetchDefinition({ config: {} })).toBeNull();
  });

  it("retries provider discovery after an empty plugin snapshot", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const config = createFirecrawlPluginConfig("firecrawl-key");
    resolvePluginWebFetchProvidersMock.mockReturnValueOnce([]).mockReturnValueOnce([provider]);

    expect(resolveWebFetchDefinition({ config })).toBeNull();
    expect(requireResolvedWebFetch(resolveWebFetchDefinition({ config })).provider.id).toBe(
      "firecrawl",
    );

    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("reuses provider discovery for the same config snapshot", () => {
    const createTool = vi.fn(() => ({
      description: "firecrawl",
      parameters: {},
      execute: async () => ({}),
    }));
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
      createTool,
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);
    const config = createFirecrawlPluginConfig("firecrawl-key");

    const first = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));
    const second = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));

    expect(first.provider).toBe(second.provider);
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(1);
    expect(createTool).toHaveBeenCalledTimes(2);
  });

  it("invalidates provider discovery when the active plugin registry version changes", () => {
    const firecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const external = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock
      .mockReturnValueOnce([firecrawl])
      .mockReturnValueOnce([external]);
    getActivePluginRegistryVersionMock
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11);
    const config = createFirecrawlPluginConfig("firecrawl-key");

    const first = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));
    const second = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));
    const third = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));

    expect(first.provider.id).toBe("firecrawl");
    expect(second.provider.id).toBe("firecrawl");
    expect(third.provider.id).toBe("thirdparty");
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates provider discovery when the same config object changes", () => {
    const firecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const external = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock
      .mockReturnValueOnce([firecrawl])
      .mockReturnValueOnce([external]);
    const config = {
      tools: { web: { fetch: { provider: "firecrawl" } } },
    } as OpenClawConfig & { tools: { web: { fetch: { provider: string } } } };

    const first = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));
    config.tools.web.fetch.provider = "thirdparty";
    const second = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));

    expect(first.provider.id).toBe("firecrawl");
    expect(second.provider.id).toBe("thirdparty");
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("evicts superseded provider discovery cache entries", () => {
    const firstFirecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const external = createThirdPartyFetchProvider();
    const secondFirecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolvePluginWebFetchProvidersMock
      .mockReturnValueOnce([firstFirecrawl])
      .mockReturnValueOnce([external])
      .mockReturnValueOnce([secondFirecrawl]);
    getActivePluginRegistryVersionMock
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(10);
    const config = createFirecrawlPluginConfig("firecrawl-key");

    const first = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));
    const second = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));
    const third = requireResolvedWebFetch(resolveWebFetchDefinition({ config }));

    expect(first.provider).toBe(firstFirecrawl);
    expect(second.provider.id).toBe("thirdparty");
    expect(third.provider).toBe(secondFirecrawl);
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledTimes(3);
  });

  it("reuses runtime provider discovery across runtime-selected providers", () => {
    const firecrawl = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    const external = createThirdPartyFetchProvider();
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([firecrawl, external]);
    const config = {} as OpenClawConfig;

    const first = requireResolvedWebFetch(
      resolveWebFetchDefinition({
        config,
        preferRuntimeProviders: true,
        runtimeWebFetch: {
          providerSource: "auto-detect",
          selectedProvider: "firecrawl",
          selectedProviderKeySource: "env",
          diagnostics: [],
        },
      }),
    );
    const second = requireResolvedWebFetch(
      resolveWebFetchDefinition({
        config,
        preferRuntimeProviders: true,
        runtimeWebFetch: {
          providerSource: "configured",
          selectedProvider: "thirdparty",
          selectedProviderKeySource: "config",
          diagnostics: [],
        },
      }),
    );

    expect(first.provider.id).toBe("firecrawl");
    expect(second.provider.id).toBe("thirdparty");
    expect(resolveRuntimeWebFetchProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("auto-detects providers from configured fallback credentials", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialFallback: (config) => {
        const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        return pluginConfig?.webSearch?.apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: pluginConfig.webSearch.apiKey,
            };
      },
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webSearch: {
                  apiKey: "shared-firecrawl-key",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("auto-detects fallback credentials when the primary fetch key is blank", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: getFirecrawlApiKey,
      getConfiguredCredentialFallback: (config) => {
        const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        return pluginConfig?.webSearch?.apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: pluginConfig.webSearch.apiKey,
            };
      },
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: "",
                },
                webSearch: {
                  apiKey: "shared-firecrawl-key",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("falls back to auto-detect when the configured provider is invalid", () => {
    const provider = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolvePluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "does-not-exist",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
  });

  it("keeps sandboxed web fetch on trusted providers even when runtime providers are preferred", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: true,
      preferRuntimeProviders: true,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("firecrawl");
    expect(resolvePluginWebFetchProvidersMock).toHaveBeenCalledWith({
      config: {},
      sandboxed: true,
    });
    expect(resolveRuntimeWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses runtime providers for non-sandboxed web fetch when runtime providers are preferred", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: false,
      preferRuntimeProviders: true,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("thirdparty");
  });

  it("resolves an explicitly configured non-bundled provider from plugin providers", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const external = createThirdPartyFetchProvider();
    resolvePluginWebFetchProvidersMock.mockReturnValue([bundled, external]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: { web: { fetch: { provider: "thirdparty" } } },
      } as OpenClawConfig,
      sandboxed: false,
      preferRuntimeProviders: false,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("thirdparty");
  });

  it("prefers an explicitly configured non-bundled provider over runtime metadata", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const external = createThirdPartyFetchProvider();
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([bundled, external]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: { web: { fetch: { provider: "thirdparty" } } },
      } as OpenClawConfig,
      runtimeWebFetch: {
        providerSource: "auto-detect",
        selectedProvider: "firecrawl",
        selectedProviderKeySource: "env",
        diagnostics: [],
      },
      sandboxed: false,
      preferRuntimeProviders: true,
    });

    expect(requireResolvedWebFetch(resolved).provider.id).toBe("thirdparty");
  });
});
