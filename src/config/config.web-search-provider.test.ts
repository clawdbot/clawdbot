import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as webSearchTesting } from "../agents/tools/web-search.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

vi.mock("../plugin-sdk/telegram-command-config.js", () => ({
  TELEGRAM_COMMAND_NAME_PATTERN: /^[a-z0-9_]+$/,
  normalizeTelegramCommandName: (value: string) => value.trim().toLowerCase(),
  normalizeTelegramCommandDescription: (value: string) => value.trim(),
  resolveTelegramCustomCommands: () => ({ commands: [], issues: [] }),
}));

const getScopedWebSearchCredential = (key: string) => (search?: Record<string, unknown>) =>
  (search?.[key] as { apiKey?: unknown } | undefined)?.apiKey;
const getConfiguredPluginWebSearchConfig =
  (pluginId: string) => (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | {
            entries?: Record<
              string,
              { config?: { webSearch?: { apiKey?: unknown; baseUrl?: unknown } } }
            >;
          }
        | undefined
    )?.entries?.[pluginId]?.config?.webSearch;
const getConfiguredPluginWebSearchCredential =
  (pluginId: string) => (config?: Record<string, unknown>) =>
    getConfiguredPluginWebSearchConfig(pluginId)(config)?.apiKey;

const mockWebSearchProviders = [
  {
    id: "brave",
    pluginId: "brave",
    envVars: ["BRAVE_API_KEY"],
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("brave"),
  },
  {
    id: "firecrawl",
    pluginId: "firecrawl",
    envVars: ["FIRECRAWL_API_KEY"],
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("firecrawl"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("firecrawl"),
  },
  {
    id: "gemini",
    pluginId: "google",
    envVars: ["GEMINI_API_KEY"],
    credentialPath: "plugins.entries.google.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("gemini"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("google"),
  },
  {
    id: "grok",
    pluginId: "xai",
    envVars: ["XAI_API_KEY"],
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("grok"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("xai"),
  },
  {
    id: "kimi",
    pluginId: "moonshot",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("kimi"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("moonshot"),
  },
  {
    id: "minimax",
    pluginId: "minimax",
    envVars: [
      "MINIMAX_CODE_PLAN_KEY",
      "MINIMAX_CODING_API_KEY",
      "MINIMAX_OAUTH_TOKEN",
      "MINIMAX_API_KEY",
    ],
    credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("minimax"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("minimax"),
  },
  {
    id: "perplexity",
    pluginId: "perplexity",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("perplexity"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("perplexity"),
  },
  {
    id: "searxng",
    pluginId: "searxng",
    envVars: ["SEARXNG_BASE_URL"],
    credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
    getCredentialValue: (search?: Record<string, unknown>) =>
      (search?.searxng as { baseUrl?: unknown } | undefined)?.baseUrl,
    getConfiguredCredentialValue: (config?: Record<string, unknown>) =>
      getConfiguredPluginWebSearchConfig("searxng")(config)?.baseUrl,
  },
  {
    id: "tavily",
    pluginId: "tavily",
    envVars: ["TAVILY_API_KEY"],
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("tavily"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("tavily"),
  },
] as const;

vi.mock("../plugins/web-search-providers.runtime.js", () => {
  return {
    resolvePluginWebSearchProviders: () => mockWebSearchProviders,
  };
});

vi.mock("../plugins/manifest-registry.js", () => {
  const buildSchema = () => ({
    type: "object",
    additionalProperties: false,
    properties: {
      webSearch: {
        type: "object",
        additionalProperties: false,
        properties: {
          apiKey: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: { type: "string" },
                  provider: { type: "string" },
                  id: { type: "string" },
                },
                required: ["source", "provider", "id"],
              },
            ],
          },
          baseUrl: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  source: { type: "string" },
                  provider: { type: "string" },
                  id: { type: "string" },
                },
                required: ["source", "provider", "id"],
              },
            ],
          },
          model: { type: "string" },
        },
      },
    },
  });

  return {
    loadPluginManifestRegistry: () => ({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          channels: [],
          providers: [],
          contracts: {
            webSearchProviders: ["brave"],
          },
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/plugins/brave",
          source: "test",
          manifestPath: "/tmp/plugins/brave/openclaw.plugin.json",
          schemaCacheKey: "test:brave",
          configSchema: buildSchema(),
        },
        ...mockWebSearchProviders
          .filter((provider) => provider.pluginId !== "brave")
          .map((provider) => ({
            id: provider.pluginId,
            origin: "bundled",
            channels: [],
            providers: [],
            contracts: {
              webSearchProviders: [provider.id],
            },
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: `/tmp/plugins/${provider.pluginId}`,
            source: "test",
            manifestPath: `/tmp/plugins/${provider.pluginId}/openclaw.plugin.json`,
            schemaCacheKey: `test:${provider.pluginId}`,
            configSchema: buildSchema(),
          })),
        {
          id: "acme-search",
          origin: "installed",
          channels: [],
          providers: [],
          contracts: {
            webSearchProviders: ["acme-search"],
          },
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/plugins/acme-search",
          source: "test",
          manifestPath: "/tmp/plugins/acme-search/openclaw.plugin.json",
          schemaCacheKey: "test:acme-search",
          configSchema: buildSchema(),
        },
      ],
      diagnostics: [],
    }),
    resolveManifestContractPluginIds: (params?: { contract?: string; origin?: string }) =>
      params?.contract === "webSearchProviders" && params.origin === "bundled"
        ? mockWebSearchProviders
            .map((provider) => provider.pluginId)
            .filter((value, index, array) => array.indexOf(value) === index)
            .toSorted((left, right) => left.localeCompare(right))
        : [],
    resolveManifestContractOwnerPluginId: (params?: { contract?: string; value?: string }) =>
      params?.contract === "webSearchProviders"
        ? mockWebSearchProviders.find((provider) => provider.id === params.value)?.pluginId
        : undefined,
  };
});

const { resolveSearchProvider } = webSearchTesting;

type ValidationMessage = {
  path?: string;
  message?: string;
  allowedValues?: unknown;
};

function findValidationMessage(messages: ValidationMessage[], path: string): ValidationMessage {
  const message = messages.find((entry) => entry.path === path);
  expect(message).toBeTruthy();
  return message ?? {};
}

function expectAllowedValuesInclude(message: ValidationMessage, values: string[]): void {
  expect(Array.isArray(message.allowedValues)).toBe(true);
  const allowedValues = Array.isArray(message.allowedValues) ? message.allowedValues : [];
  for (const value of values) {
    expect(allowedValues).toContain(value);
  }
}

describe("web search provider config", () => {
  it("does not warn for brave plugin config when bundled web search allowlist compat applies", () => {
    const res = validateConfigObjectWithPlugins({
      plugins: {
        allow: ["imessage", "memory-core"],
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "test-brave-key", // pragma: allowlist secret
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "brave",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(
      res.warnings.some(
        (warning) =>
          warning.path === "plugins.entries.brave" &&
          warning.message.includes("plugin disabled (not in allowlist) but config is present"),
      ),
    ).toBe(false);
  });

  it("accepts perplexity provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "perplexity",
        providerConfig: {
          apiKey: "test-key", // pragma: allowlist secret
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "gemini",
        providerConfig: {
          apiKey: "test-key", // pragma: allowlist secret
          model: "gemini-2.5-flash",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts firecrawl provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "firecrawl",
        providerConfig: {
          apiKey: "fc-test-key", // pragma: allowlist secret
          baseUrl: "https://api.firecrawl.dev",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts tavily provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "tavily",
        providerConfig: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "TAVILY_API_KEY",
          },
          baseUrl: "https://api.tavily.com",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts minimax provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "minimax",
        providerConfig: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "MINIMAX_CODE_PLAN_KEY",
          },
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts searxng provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "searxng",
        providerConfig: {
          baseUrl: {
            source: "env",
            provider: "default",
            id: "SEARXNG_BASE_URL",
          },
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("rejects legacy scoped Tavily config", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            provider: "tavily",
            tavily: {
              apiKey: "tvly-test-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("detects legacy scoped provider config for bundled providers", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            provider: "gemini",
            gemini: {
              apiKey: "legacy-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts gemini provider with no extra config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "gemini",
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts provider ids registered by installed plugin manifests", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "acme-search",
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("rejects installable provider ids when the plugin is not active", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "brave",
      }),
      {
        pluginMetadataSnapshot: {
          manifestRegistry: {
            plugins: [],
            diagnostics: [],
          },
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    const issue = findValidationMessage(res.issues, "tools.web.search.provider");
    expect(issue.message).toBe(
      'web_search provider is not available: brave (install or enable plugin "brave", then run openclaw doctor --fix)',
    );
    expectAllowedValuesInclude(issue, ["brave"]);
  });

  it("rejects unknown provider ids without plugin evidence", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            provider: "brvae",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    const issue = findValidationMessage(res.issues, "tools.web.search.provider");
    expect(issue.message).toBe("unknown web_search provider: brvae");
    expectAllowedValuesInclude(issue, ["acme-search", "brave", "gemini"]);
  });

  it("warns for unknown provider ids when stale plugin config is present", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            provider: "missing-third-party",
          },
        },
      },
      plugins: {
        entries: {
          "missing-third-party": {
            config: {
              webSearch: {},
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    const warning = findValidationMessage(res.warnings, "tools.web.search.provider");
    expect(warning.message).toContain("unknown web_search provider: missing-third-party");
  });
});

describe("web search provider auto-detection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_CODE_PLAN_KEY;
    delete process.env.MINIMAX_CODING_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.TAVILY_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("falls back to brave when no keys available", () => {
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects brave when only BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects gemini when only GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("auto-detects tavily when only TAVILY_API_KEY is set", () => {
    process.env.TAVILY_API_KEY = "tvly-test-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("tavily");
  });

  it("auto-detects minimax when only MINIMAX_API_KEY is set", () => {
    process.env.MINIMAX_API_KEY = "test-minimax-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("minimax");
  });

  it("auto-detects firecrawl when only FIRECRAWL_API_KEY is set", () => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("firecrawl");
  });

  it("auto-detects searxng when only SEARXNG_BASE_URL is set", () => {
    process.env.SEARXNG_BASE_URL = "http://localhost:8080";
    expect(resolveSearchProvider({})).toBe("searxng");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects minimax when only MINIMAX_CODE_PLAN_KEY is set", () => {
    process.env.MINIMAX_CODE_PLAN_KEY = "sk-cp-test";
    expect(resolveSearchProvider({})).toBe("minimax");
  });

  it("auto-detects minimax when only MINIMAX_OAUTH_TOKEN is set", () => {
    process.env.MINIMAX_OAUTH_TOKEN = "oauth-test-token"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("minimax");
  });

  it("auto-detects perplexity when only PERPLEXITY_API_KEY is set", () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects perplexity when only OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects grok when only XAI_API_KEY is set", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("auto-detects kimi when only MOONSHOT_API_KEY is set", () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("follows alphabetical order — brave wins when multiple keys available", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("gemini wins over grok, kimi, and perplexity when brave unavailable", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("grok wins over kimi and perplexity when brave and gemini unavailable", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("explicit provider always wins regardless of keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    expect(
      resolveSearchProvider({ provider: "gemini" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("gemini");
  });
});
