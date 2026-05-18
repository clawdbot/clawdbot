import { describe, expect, it, vi } from "vitest";

const REGISTRY_IDS = [
  "agents.defaults.memorySearch.remote.apiKey",
  "agents.list[].memorySearch.remote.apiKey",
  "channels.discord.token",
  "channels.discord.accounts.ops.token",
  "channels.discord.accounts.chat.token",
  "channels.telegram.botToken",
  "gateway.auth.token",
  "gateway.auth.password",
  "gateway.remote.token",
  "gateway.remote.password",
  "models.providers.*.apiKey",
  "messages.tts.providers.openai.apiKey",
  "plugins.entries.voice-call.config.twilio.authToken",
  "plugins.entries.firecrawl.config.webFetch.apiKey",
  "plugins.entries.firecrawl.config.webSearch.apiKey",
  "plugins.entries.brave.config.webSearch.apiKey",
  "plugins.entries.exa.config.webSearch.apiKey",
  "plugins.entries.gemini.config.webSearch.apiKey",
  "plugins.entries.other-fetch.config.webFetch.apiKey",
  "plugins.entries.other-fetch.config.webSearch.apiKey",
  "skills.entries.demo.apiKey",
  "tools.web.fetch.firecrawl.apiKey",
  "tools.web.search.apiKey",
  "tools.web.search.*.apiKey",
] as const;

function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

vi.mock("../secrets/target-registry.js", () => ({
  listSecretTargetRegistryEntries: vi.fn(() =>
    REGISTRY_IDS.map((id) => ({
      id,
      pathPattern: id,
    })),
  ),
  discoverConfigSecretTargetsByIds: vi.fn((config: unknown, targetIds?: Iterable<string>) => {
    const allowed = targetIds ? new Set(targetIds) : null;
    const out: Array<{ entry: { id: string }; path: string; pathSegments: string[] }> = [];
    const matches = (pattern: string, path: string): boolean => {
      const patternSegments = pattern.split(".");
      const pathSegments = path.split(".");
      if (patternSegments.length !== pathSegments.length) {
        return false;
      }
      return patternSegments.every(
        (segment, index) => segment === "*" || segment === pathSegments[index],
      );
    };
    const collectPaths = (node: unknown, segments: string[], prefix: string[] = []): string[] => {
      const [segment, ...rest] = segments;
      if (!segment) {
        return node === undefined ? [] : [prefix.join(".")];
      }
      if (!node || typeof node !== "object" || Array.isArray(node)) {
        return [];
      }
      if (segment === "*") {
        return Object.entries(node).flatMap(([key, value]) =>
          collectPaths(value, rest, [...prefix, key]),
        );
      }
      return collectPaths((node as Record<string, unknown>)[segment], rest, [...prefix, segment]);
    };
    const record = (targetId: string, path: string) => {
      if (allowed && !allowed.has(targetId)) {
        return;
      }
      out.push({ entry: { id: targetId }, path, pathSegments: path.split(".") });
    };
    for (const id of REGISTRY_IDS) {
      if (id.includes("*")) {
        for (const path of collectPaths(config, id.split("."))) {
          if (matches(id, path)) {
            record(id, path);
          }
        }
        continue;
      }
      if (readPath(config, id) !== undefined) {
        record(id, id);
      }
    }
    return out;
  }),
}));

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: vi.fn((params: { config?: Record<string, unknown> }) => [
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      autoDetectOrder: 50,
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            firecrawl?: { config?: { webFetch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.firecrawl?.config?.webFetch?.apiKey,
      getConfiguredCredentialFallback: () => ({
        path: "plugins.entries.firecrawl.config.webSearch.apiKey",
        value: (
          params.config as {
            plugins?: {
              entries?: {
                firecrawl?: { config?: { webSearch?: { apiKey?: unknown } } };
              };
            };
          }
        )?.plugins?.entries?.firecrawl?.config?.webSearch?.apiKey,
      }),
      getCredentialValue: (fetchConfig?: { firecrawl?: { apiKey?: unknown } }) =>
        fetchConfig?.firecrawl?.apiKey,
    },
    {
      pluginId: "other-fetch",
      id: "other",
      autoDetectOrder: 100,
      credentialPath: "plugins.entries.other-fetch.config.webFetch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            "other-fetch"?: { config?: { webFetch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.["other-fetch"]?.config?.webFetch?.apiKey,
      getConfiguredCredentialFallback: () => ({
        path: "plugins.entries.other-fetch.config.webSearch.apiKey",
        value: undefined,
      }),
      getCredentialValue: (): undefined => undefined,
    },
  ]),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: vi.fn(() => [
    {
      pluginId: "brave",
      id: "brave",
      autoDetectOrder: 10,
      credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        tools?: { web?: { search?: { apiKey?: unknown } } };
        plugins?: {
          entries?: {
            brave?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) =>
        config?.plugins?.entries?.brave?.config?.webSearch?.apiKey ??
        config?.tools?.web?.search?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (searchConfig?: { apiKey?: unknown }) => searchConfig?.apiKey,
    },
    {
      pluginId: "firecrawl",
      id: "firecrawl",
      autoDetectOrder: 60,
      credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            firecrawl?: {
              config?: { webFetch?: { apiKey?: unknown }; webSearch?: { apiKey?: unknown } };
            };
          };
        };
      }) => config?.plugins?.entries?.firecrawl?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (config?: {
        plugins?: {
          entries?: {
            firecrawl?: { config?: { webFetch?: { apiKey?: unknown } } };
          };
        };
      }) => {
        const apiKey = config?.plugins?.entries?.firecrawl?.config?.webFetch?.apiKey;
        return apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webFetch.apiKey",
              value: apiKey,
            };
      },
      getCredentialValue: (): undefined => undefined,
    },
    {
      pluginId: "exa",
      id: "exa",
      autoDetectOrder: 65,
      credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
      getConfiguredCredentialValue: (config?: {
        plugins?: {
          entries?: {
            exa?: { config?: { webSearch?: { apiKey?: unknown } } };
          };
        };
      }) => config?.plugins?.entries?.exa?.config?.webSearch?.apiKey,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (searchConfig?: { exa?: { apiKey?: unknown } }) =>
        searchConfig?.exa?.apiKey,
    },
    {
      pluginId: "gemini",
      id: "gemini",
      autoDetectOrder: 20,
      credentialPath: "plugins.entries.gemini.config.webSearch.apiKey",
      getConfiguredCredentialValue: (): undefined => undefined,
      getConfiguredCredentialFallback: (config?: {
        models?: { providers?: { google?: { apiKey?: unknown } } };
      }) => ({
        path: "models.providers.google.apiKey",
        value: config?.models?.providers?.google?.apiKey,
      }),
      getCredentialValue: (): undefined => undefined,
    },
    {
      pluginId: "ollama",
      id: "ollama",
      autoDetectOrder: 110,
      credentialPath: "",
      getConfiguredCredentialValue: (): undefined => undefined,
      getConfiguredCredentialFallback: (): undefined => undefined,
      getCredentialValue: (): undefined => undefined,
    },
  ]),
}));

import {
  getAgentRuntimeCommandSecretTargetIds,
  getCapabilityWebFetchCommandSecretTargets,
  getCapabilityWebFetchCommandSecretTargetIds,
  getCapabilityWebSearchCommandSecretTargets,
  getCapabilityWebSearchCommandSecretTargetIds,
  getModelsCommandSecretTargetIds,
  getQrRemoteCommandSecretTargetIds,
  getScopedChannelsCommandSecretTargets,
  getSecurityAuditCommandSecretTargetIds,
} from "./command-secret-targets.js";

describe("command secret target ids", () => {
  it("keeps static qr remote targets out of the registry path", () => {
    const ids = getQrRemoteCommandSecretTargetIds();
    expect(ids).toEqual(new Set(["gateway.remote.token", "gateway.remote.password"]));
  });

  it("keeps static model targets out of the registry path", () => {
    const ids = getModelsCommandSecretTargetIds();
    expect(ids.has("models.providers.*.apiKey")).toBe(true);
    expect(ids.has("models.providers.*.request.tls.key")).toBe(true);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("includes memorySearch remote targets for agent runtime commands", () => {
    const ids = getAgentRuntimeCommandSecretTargetIds();
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("agents.list[].memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("scopes capability web search commands to search credential surfaces only", () => {
    const ids = getCapabilityWebSearchCommandSecretTargetIds();
    expect(ids.has("tools.web.search.apiKey")).toBe(true);
    expect(ids.has("tools.web.search.*.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);
    expect(ids.has("plugins.entries.voice-call.config.twilio.authToken")).toBe(false);
    expect(ids.has("models.providers.openai.apiKey")).toBe(false);
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(false);
    expect(ids.has("messages.tts.providers.openai.apiKey")).toBe(false);
    expect(ids.has("skills.entries.demo.apiKey")).toBe(false);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("scopes capability web fetch commands to fetch credential surfaces only", () => {
    const ids = getCapabilityWebFetchCommandSecretTargetIds();
    expect(ids.has("tools.web.search.apiKey")).toBe(false);
    expect(ids.has("tools.web.fetch.firecrawl.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(false);
    expect(ids.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(true);
    expect(ids.has("plugins.entries.voice-call.config.twilio.authToken")).toBe(false);
    expect(ids.has("models.providers.openai.apiKey")).toBe(false);
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(false);
    expect(ids.has("messages.tts.providers.openai.apiKey")).toBe(false);
    expect(ids.has("skills.entries.demo.apiKey")).toBe(false);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("scopes configured web search command targets to the selected provider", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "firecrawl", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
              },
            },
          },
          exa: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("uses an explicit search provider override when scoping command targets", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets(
      {
        tools: { web: { search: { provider: "exa", enabled: true } } },
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
                },
              },
            },
            exa: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
                },
              },
            },
          },
        },
      } as never,
      { providerId: "firecrawl" },
    );

    expect(scoped.targetIds).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("discovers explicit search provider targets even when config selects another provider", async () => {
    const webSearchProviders = await import("../plugins/web-search-providers.runtime.js");
    vi.mocked(webSearchProviders.resolvePluginWebSearchProviders).mockImplementationOnce(
      (params: { config?: { tools?: { web?: { search?: { provider?: string } } } } }) => {
        const selectedProvider = params.config?.tools?.web?.search?.provider;
        return selectedProvider === "firecrawl"
          ? ([
              {
                pluginId: "firecrawl",
                id: "firecrawl",
                credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
                getConfiguredCredentialValue: (config?: {
                  plugins?: {
                    entries?: {
                      firecrawl?: { config?: { webSearch?: { apiKey?: unknown } } };
                    };
                  };
                }) => config?.plugins?.entries?.firecrawl?.config?.webSearch?.apiKey,
                getConfiguredCredentialFallback: (): undefined => undefined,
                getCredentialValue: (): undefined => undefined,
              },
            ] as never)
          : ([
              {
                pluginId: "exa",
                id: "exa",
                credentialPath: "plugins.entries.exa.config.webSearch.apiKey",
                getConfiguredCredentialValue: (config?: {
                  plugins?: {
                    entries?: {
                      exa?: { config?: { webSearch?: { apiKey?: unknown } } };
                    };
                  };
                }) => config?.plugins?.entries?.exa?.config?.webSearch?.apiKey,
                getConfiguredCredentialFallback: (): undefined => undefined,
                getCredentialValue: (): undefined => undefined,
              },
            ] as never);
      },
    );

    const scoped = getCapabilityWebSearchCommandSecretTargets(
      {
        tools: { web: { search: { provider: "exa", enabled: true } } },
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
      } as never,
      { providerId: "firecrawl" },
    );

    expect(scoped.targetIds).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("keeps selected top-level web search credential refs in command targets", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: {
        web: {
          search: {
            provider: "brave",
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set(["plugins.entries.brave.config.webSearch.apiKey", "tools.web.search.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("maps selected legacy scoped web search refs to registry targets", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: {
        web: {
          search: {
            provider: "exa",
            enabled: true,
            exa: {
              apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set(["plugins.entries.exa.config.webSearch.apiKey", "tools.web.search.*.apiKey"]),
    );
    expect(scoped.allowedPaths).toEqual(
      new Set(["plugins.entries.exa.config.webSearch.apiKey", "tools.web.search.exa.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("skips stale legacy scoped web search refs when plugin credential wins", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: {
        web: {
          search: {
            provider: "exa",
            enabled: true,
            exa: {
              apiKey: { source: "env", provider: "default", id: "STALE_EXA_API_KEY" },
            },
          },
        },
      },
      plugins: {
        entries: {
          exa: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(new Set(["plugins.entries.exa.config.webSearch.apiKey"]));
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("maps selected fallback credential paths to registry targets", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "gemini", enabled: true } } },
      models: {
        providers: {
          google: {
            apiKey: { source: "env", provider: "default", id: "GOOGLE_API_KEY" },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set(["models.providers.*.apiKey", "plugins.entries.gemini.config.webSearch.apiKey"]),
    );
    expect(scoped.allowedPaths).toEqual(
      new Set(["models.providers.google.apiKey", "plugins.entries.gemini.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toEqual(new Set(["models.providers.google.apiKey"]));
  });

  it("maps selected Ollama web search to its model provider key", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "ollama", enabled: true } } },
      models: {
        providers: {
          ollama: {
            apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(new Set(["models.providers.*.apiKey"]));
    expect(scoped.allowedPaths).toEqual(new Set(["models.providers.ollama.apiKey"]));
    expect(scoped.forcedActivePaths).toEqual(new Set(["models.providers.ollama.apiKey"]));
  });

  it("uses Firecrawl web fetch credentials as search fallback targets", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "firecrawl", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: "firecrawl-key",
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set([
        "plugins.entries.firecrawl.config.webFetch.apiKey",
        "plugins.entries.firecrawl.config.webSearch.apiKey",
      ]),
    );
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
  });

  it("includes configured search fallback targets for auto-detect", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: "firecrawl-key",
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
  });

  it("does not force later search fallback refs after an earlier provider credential", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: {
        web: {
          search: {
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
          },
        },
      },
      models: {
        providers: {
          google: {
            apiKey: "google-key",
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(false);
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("uses runtime auto-detect order before stopping at a search credential", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { enabled: true } } },
      models: {
        providers: {
          google: {
            apiKey: "google-key",
          },
        },
      },
      plugins: {
        entries: {
          exa: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["models.providers.google.apiKey", "plugins.entries.exa.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(new Set(["models.providers.google.apiKey"]));
  });

  it("treats unresolved search fallback refs as optional during auto-detect", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_FIRECRAWL_API_KEY",
                },
              },
            },
          },
          exa: {
            config: {
              webSearch: {
                apiKey: "exa-key",
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set([
        "plugins.entries.exa.config.webSearch.apiKey",
        "plugins.entries.firecrawl.config.webFetch.apiKey",
      ]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
  });

  it("does not force search fallback refs when web search is disabled", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { enabled: false, provider: "firecrawl" } } },
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
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("limits auto-detect wildcard fallback paths to the concrete configured path", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { enabled: true } } },
      models: {
        providers: {
          google: {
            apiKey: "google-key",
          },
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(new Set(["models.providers.google.apiKey"]));
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(new Set(["models.providers.google.apiKey"]));
  });

  it("falls back to broad web search command targets for stale configured providers", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "stale", enabled: true } } },
      plugins: {
        entries: {
          exa: {
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "EXA_API_KEY" },
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(getCapabilityWebSearchCommandSecretTargetIds());
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("includes configured search fallback targets for stale configured providers", () => {
    const scoped = getCapabilityWebSearchCommandSecretTargets({
      tools: { web: { search: { provider: "stale", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: "firecrawl-key",
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );
  });

  it("adds configured fetch fallback credential paths only when the fetch key is absent", () => {
    const fallbackRef = { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" };
    const fallbackOnly = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { provider: "firecrawl", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: fallbackRef,
              },
            },
          },
        },
      },
    } as never);

    expect(fallbackOnly.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(
      true,
    );
    expect(fallbackOnly.allowedPaths).toBeUndefined();
    expect(fallbackOnly.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );

    const fetchConfigured = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { provider: "firecrawl", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
              },
              webSearch: {
                apiKey: fallbackRef,
              },
            },
          },
        },
      },
    } as never);

    expect(fetchConfigured.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(
      false,
    );
    expect(fetchConfigured.allowedPaths).toBeUndefined();
    expect(fetchConfigured.forcedActivePaths).toBeUndefined();
  });

  it("keeps selected legacy Firecrawl web fetch refs in command targets", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets({
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
            enabled: true,
            firecrawl: {
              apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds).toEqual(
      new Set([
        "plugins.entries.firecrawl.config.webFetch.apiKey",
        "tools.web.fetch.firecrawl.apiKey",
      ]),
    );
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("does not add fallback credential paths for non-selected fetch providers", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { provider: "other", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "firecrawl-key",
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(false);
    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);
    expect(scoped.targetIds.has("plugins.entries.other-fetch.config.webFetch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("uses an explicit fetch provider override when scoping fallback credential paths", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets(
      {
        tools: { web: { fetch: { enabled: true } } },
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
      } as never,
      { providerId: "firecrawl" },
    );

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("includes configured fetch fallback targets for auto-detect", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "firecrawl-key",
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("does not force fetch fallback refs when web fetch is disabled", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { enabled: false, provider: "firecrawl" } } },
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
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(false);
    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("treats unresolved fetch fallback refs as optional during auto-detect", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_FIRECRAWL_SEARCH_API_KEY",
                },
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("includes configured fetch fallback targets for stale configured providers", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { provider: "stale", enabled: true } } },
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webSearch: {
                apiKey: "firecrawl-key",
              },
            },
          },
        },
      },
    } as never);

    expect(scoped.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(true);
    expect(scoped.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
    expect(scoped.forcedActivePaths).toBeUndefined();
    expect(scoped.optionalActivePaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );
  });

  it("falls back to broad web fetch command targets for stale configured providers", () => {
    const scoped = getCapabilityWebFetchCommandSecretTargets({
      tools: { web: { fetch: { provider: "stale", enabled: true } } },
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
    } as never);

    expect(scoped.targetIds).toEqual(getCapabilityWebFetchCommandSecretTargetIds());
    expect(scoped.forcedActivePaths).toBeUndefined();
  });

  it("includes channel targets for agent runtime when delivery needs them", () => {
    const ids = getAgentRuntimeCommandSecretTargetIds({ includeChannelTargets: true });
    expect(ids.has("channels.discord.token")).toBe(true);
    expect(ids.has("channels.telegram.botToken")).toBe(true);
  });

  it("includes gateway auth and channel targets for security audit", () => {
    const ids = getSecurityAuditCommandSecretTargetIds();
    expect(ids.has("channels.discord.token")).toBe(true);
    expect(ids.has("gateway.auth.token")).toBe(true);
    expect(ids.has("gateway.auth.password")).toBe(true);
    expect(ids.has("gateway.remote.token")).toBe(true);
    expect(ids.has("gateway.remote.password")).toBe(true);
  });

  it("scopes channel targets to the requested channel", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {} as never,
      channel: "discord",
    });

    expect(scoped.targetIds).toEqual(
      new Set([
        "channels.discord.accounts.chat.token",
        "channels.discord.accounts.ops.token",
        "channels.discord.token",
      ]),
    );
  });

  it("does not coerce missing accountId to default when channel is scoped", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            defaultAccount: "ops",
            accounts: {
              ops: {
                token: { source: "env", provider: "default", id: "DISCORD_OPS" },
              },
            },
          },
        },
      } as never,
      channel: "discord",
    });

    expect(scoped.allowedPaths).toBeUndefined();
    expect(scoped.targetIds).toEqual(
      new Set([
        "channels.discord.accounts.chat.token",
        "channels.discord.accounts.ops.token",
        "channels.discord.token",
      ]),
    );
  });

  it("scopes allowed paths to channel globals + selected account", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_DEFAULT" },
            accounts: {
              ops: {
                token: { source: "env", provider: "default", id: "DISCORD_OPS" },
              },
              chat: {
                token: { source: "env", provider: "default", id: "DISCORD_CHAT" },
              },
            },
          },
        },
      } as never,
      channel: "discord",
      accountId: "ops",
    });

    expect(scoped.allowedPaths).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.ops.token"]),
    );
  });

  it("keeps account-scoped allowedPaths as an empty set when scoped target paths are absent", () => {
    const scoped = getScopedChannelsCommandSecretTargets({
      config: {
        channels: {
          discord: {
            accounts: {
              ops: { enabled: true },
            },
          },
        },
      } as never,
      channel: "custom-plugin-channel-without-secret-targets",
      accountId: "ops",
    });

    expect(scoped.allowedPaths).toEqual(new Set());
  });
});
