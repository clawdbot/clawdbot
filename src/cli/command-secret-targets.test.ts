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
  "models.providers.google.apiKey",
  "models.providers.openai.apiKey",
  "messages.tts.providers.openai.apiKey",
  "plugins.entries.firecrawl.config.webFetch.apiKey",
  "plugins.entries.firecrawl.config.webSearch.apiKey",
  "plugins.entries.exa.config.webSearch.apiKey",
  "plugins.entries.google.config.webSearch.apiKey",
  "plugins.entries.readerlab.config.webFetch.apiKey",
  "plugins.entries.searchlab.config.webSearch.apiKey",
  "skills.entries.demo.apiKey",
  "tools.web.search.apiKey",
] as const;

vi.mock("../secrets/target-registry.js", () => ({
  listSecretTargetRegistryEntries: vi.fn(() =>
    REGISTRY_IDS.map((id) => ({
      id,
    })),
  ),
  discoverConfigSecretTargetsByIds: vi.fn((config: unknown, targetIds?: Iterable<string>) => {
    const allowed = targetIds ? new Set(targetIds) : null;
    const out: Array<{ path: string; pathSegments: string[] }> = [];
    const isAllowed = (path: string) =>
      !allowed ||
      allowed.has(path) ||
      (allowed.has("models.providers.*.apiKey") && /^models\.providers\.[^.]+\.apiKey$/.test(path));
    const record = (path: string) => {
      if (!isAllowed(path)) {
        return;
      }
      out.push({ path, pathSegments: path.split(".") });
    };

    const channels = (config as { channels?: Record<string, unknown> } | undefined)?.channels;
    const discord = channels?.discord as
      | { token?: unknown; accounts?: Record<string, { token?: unknown }> }
      | undefined;

    if (discord?.token !== undefined) {
      record("channels.discord.token");
    }
    for (const [accountId, account] of Object.entries(discord?.accounts ?? {})) {
      if (account?.token !== undefined) {
        record(`channels.discord.accounts.${accountId}.token`);
      }
    }
    const models = (config as { models?: { providers?: Record<string, { apiKey?: unknown }> } })
      ?.models;
    for (const [providerId, provider] of Object.entries(models?.providers ?? {})) {
      if (provider?.apiKey !== undefined) {
        record(`models.providers.${providerId}.apiKey`);
      }
    }
    const plugins = (
      config as {
        plugins?: {
          entries?: Record<
            string,
            { config?: { webSearch?: { apiKey?: unknown }; webFetch?: { apiKey?: unknown } } }
          >;
        };
      }
    )?.plugins;
    for (const [pluginId, entry] of Object.entries(plugins?.entries ?? {})) {
      if (entry?.config?.webSearch?.apiKey !== undefined) {
        record(`plugins.entries.${pluginId}.config.webSearch.apiKey`);
      }
      if (entry?.config?.webFetch?.apiKey !== undefined) {
        record(`plugins.entries.${pluginId}.config.webFetch.apiKey`);
      }
    }
    const tools = (config as { tools?: { web?: { fetch?: { firecrawl?: { apiKey?: unknown } } } } })
      ?.tools;
    if (tools?.web?.fetch?.firecrawl?.apiKey !== undefined) {
      record("tools.web.fetch.firecrawl.apiKey");
    }
    return out;
  }),
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  resolveManifestContractOwnerPluginId: vi.fn(
    ({ value }: { value?: string }) =>
      ({
        firecrawl: "firecrawl",
        gemini: "google",
        pagefetch: "readerlab",
        serpapi: "searchlab",
      })[value ?? ""],
  ),
}));

import {
  getAgentRuntimeCommandSecretTargetIds,
  getMemoryEmbeddingCommandSecretTargetIds,
  getModelsCommandSecretTargetIds,
  getQrRemoteCommandSecretTargetIds,
  getScopedChannelsCommandSecretTargets,
  getSecurityAuditCommandSecretTargetIds,
  getTtsCommandSecretTargetIds,
  getWebFetchCommandSecretTargets,
  getWebFetchCommandSecretTargetIds,
  getWebSearchCommandSecretTargets,
  getWebSearchCommandSecretTargetIds,
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
    expect(ids.has("tools.web.fetch.firecrawl.apiKey")).toBe(true);
    expect(ids.has("channels.discord.token")).toBe(false);
  });

  it("scopes capability target ids to the provider family", () => {
    const webSearch = getWebSearchCommandSecretTargetIds();
    expect(webSearch).toEqual(
      new Set([
        "plugins.entries.exa.config.webSearch.apiKey",
        "plugins.entries.firecrawl.config.webSearch.apiKey",
        "plugins.entries.google.config.webSearch.apiKey",
        "plugins.entries.searchlab.config.webSearch.apiKey",
        "tools.web.search.apiKey",
      ]),
    );
    expect(webSearch.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(false);
    expect(webSearch.has("models.providers.*.apiKey")).toBe(false);

    const webFetch = getWebFetchCommandSecretTargetIds();
    expect(webFetch).toEqual(
      new Set([
        "plugins.entries.firecrawl.config.webFetch.apiKey",
        "plugins.entries.readerlab.config.webFetch.apiKey",
        "tools.web.fetch.firecrawl.apiKey",
      ]),
    );
    expect(webFetch.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(false);

    const tts = getTtsCommandSecretTargetIds();
    expect(tts.has("models.providers.*.apiKey")).toBe(true);
    expect(tts.has("messages.tts.providers.*.apiKey")).toBe(true);
    expect(tts.has("plugins.entries.exa.config.webSearch.apiKey")).toBe(false);

    const memory = getMemoryEmbeddingCommandSecretTargetIds();
    expect(memory.has("models.providers.*.apiKey")).toBe(true);
    expect(memory.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(memory.has("messages.tts.providers.*.apiKey")).toBe(false);
  });

  it("selects model-provider fallback credentials for selected web search providers", () => {
    const selected = getWebSearchCommandSecretTargets({
      config: {
        tools: { web: { search: { provider: "gemini" } } },
        models: {
          providers: {
            google: { apiKey: { source: "env", id: "GEMINI_API_KEY" } },
            openai: { apiKey: { source: "env", id: "OPENAI_API_KEY" } },
          },
        },
        plugins: {
          entries: {
            firecrawl: { config: { webSearch: { apiKey: { source: "env", id: "FC" } } } },
          },
        },
      } as never,
      provider: "gemini",
    });

    expect(selected.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(selected.allowedPaths).toEqual(new Set(["models.providers.google.apiKey"]));

    const pluginCredential = getWebSearchCommandSecretTargets({
      config: {
        tools: { web: { search: { provider: "gemini" } } },
        models: {
          providers: {
            google: { apiKey: { source: "env", id: "GEMINI_API_KEY" } },
          },
        },
        plugins: {
          entries: {
            google: { config: { webSearch: { apiKey: { source: "env", id: "GOOGLE" } } } },
          },
        },
      } as never,
      provider: "gemini",
    });
    expect(pluginCredential.targetIds.has("models.providers.*.apiKey")).toBe(false);
    expect(pluginCredential.allowedPaths).toEqual(
      new Set(["plugins.entries.google.config.webSearch.apiKey"]),
    );

    const unselected = getWebSearchCommandSecretTargets({
      config: {
        models: {
          providers: {
            google: { apiKey: { source: "env", id: "GEMINI_API_KEY" } },
          },
        },
      } as never,
      provider: "tavily",
    });
    expect(unselected.targetIds.has("models.providers.*.apiKey")).toBe(false);
    expect(unselected.allowedPaths).toEqual(new Set());

    const configuredOnly = getWebSearchCommandSecretTargets({
      config: {
        tools: { web: { search: { provider: "gemini" } } },
        models: {
          providers: {
            google: { apiKey: { source: "env", id: "GEMINI_API_KEY" } },
          },
        },
      } as never,
    });
    expect(configuredOnly.targetIds.has("models.providers.*.apiKey")).toBe(true);
    expect(configuredOnly.allowedPaths).toEqual(new Set(["models.providers.google.apiKey"]));

    const externalOwner = getWebSearchCommandSecretTargets({
      config: {
        plugins: {
          entries: {
            serpapi: { config: { webSearch: { apiKey: { source: "env", id: "WRONG" } } } },
            searchlab: { config: { webSearch: { apiKey: { source: "env", id: "SERP" } } } },
          },
        },
      } as never,
      provider: "serpapi",
    });
    expect(externalOwner.allowedPaths).toEqual(
      new Set(["plugins.entries.searchlab.config.webSearch.apiKey"]),
    );
  });

  it("selects same-plugin web search fallback credentials for web fetch providers", () => {
    const selected = getWebFetchCommandSecretTargets({
      config: {
        tools: { web: { fetch: { provider: "firecrawl" } } },
        plugins: {
          entries: {
            exa: { config: { webSearch: { apiKey: { source: "env", id: "EXA" } } } },
            firecrawl: { config: { webSearch: { apiKey: { source: "env", id: "FC" } } } },
          },
        },
      } as never,
      provider: "firecrawl",
    });

    expect(selected.targetIds.has("plugins.entries.firecrawl.config.webFetch.apiKey")).toBe(true);
    expect(selected.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(true);
    expect(selected.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );

    const configuredOnly = getWebFetchCommandSecretTargets({
      config: {
        tools: { web: { fetch: { provider: "firecrawl" } } },
        plugins: {
          entries: {
            firecrawl: { config: { webSearch: { apiKey: { source: "env", id: "FC" } } } },
          },
        },
      } as never,
    });
    expect(configuredOnly.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(
      true,
    );
    expect(configuredOnly.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
    );

    const fetchCredential = getWebFetchCommandSecretTargets({
      config: {
        tools: { web: { fetch: { provider: "firecrawl" } } },
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: { apiKey: { source: "env", id: "FC_FETCH" } },
                webSearch: { apiKey: { source: "env", id: "FC_SEARCH" } },
              },
            },
          },
        },
      } as never,
      provider: "firecrawl",
    });
    expect(fetchCredential.targetIds.has("plugins.entries.firecrawl.config.webSearch.apiKey")).toBe(
      false,
    );
    expect(fetchCredential.allowedPaths).toEqual(
      new Set(["plugins.entries.firecrawl.config.webFetch.apiKey"]),
    );

    const externalOwner = getWebFetchCommandSecretTargets({
      config: {
        plugins: {
          entries: {
            pagefetch: { config: { webFetch: { apiKey: { source: "env", id: "WRONG" } } } },
            readerlab: { config: { webFetch: { apiKey: { source: "env", id: "PAGE" } } } },
          },
        },
      } as never,
      provider: "pagefetch",
    });
    expect(externalOwner.allowedPaths).toEqual(
      new Set(["plugins.entries.readerlab.config.webFetch.apiKey"]),
    );
  });

  it("keeps legacy Firecrawl web fetch targets available for selected fetch commands", () => {
    const selected = getWebFetchCommandSecretTargets({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
              firecrawl: { apiKey: { source: "env", id: "FIRECRAWL_API_KEY" } },
            },
          },
        },
      } as never,
      provider: "firecrawl",
    });

    expect(selected.targetIds.has("tools.web.fetch.firecrawl.apiKey")).toBe(true);
    expect(selected.allowedPaths).toEqual(new Set(["tools.web.fetch.firecrawl.apiKey"]));
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
