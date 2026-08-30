// Codex tests cover plugin inventory plugin behavior.
import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
} from "./config.js";
import {
  findCodexMarketplacePluginSummary,
  readCodexPluginInventory,
  resolveOwnedAppReadOnlyToolConfigKeys,
} from "./plugin-inventory.js";
import {
  appInfo,
  appSummary,
  asPluginInstalled,
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin inventory", () => {
  it("does not classify keys shared with writable tools as read-only", () => {
    const app: v2.AppInfo = {
      ...appInfo("linear", true),
      toolSummaries: [
        {
          name: "fetch",
          title: "Fetch",
          description: "Fetch a Linear issue.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: true,
        },
        {
          name: "linear_fetch",
          title: "Save issue",
          description: "Create or update a Linear issue.",
          isEnabled: true,
          disabledReason: null,
          isReadOnly: false,
        },
      ],
    };

    expect(resolveOwnedAppReadOnlyToolConfigKeys(app)).toStrictEqual({
      readOnlyToolConfigKeys: ["Fetch", "fetch"],
    });
  });

  it("returns enabled migrated curated plugins with stable owned app ids", async () => {
    const appCache = await cachedApps(appInfo("google-calendar-app", true));
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
        slack: curatedPlugin("slack", { enabled: false }),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("google-calendar"), activePlugin("slack")]);
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "google-calendar",
          });
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    const record = inventory.records[0];
    expect(record?.policy.pluginName).toBe("google-calendar");
    expect(record?.summary.installed).toBe(true);
    expect(record?.summary.enabled).toBe(true);
    expect(record?.appOwnership).toBe("proven");
    expect(record?.ownedAppIds).toStrictEqual(["google-calendar-app"]);
    expect(record?.apps).toStrictEqual([
      {
        id: "google-calendar-app",
        name: "google-calendar-app",
        accessible: true,
        enabled: true,
        needsAuth: false,
      },
    ]);
    expect(calls).toEqual(["plugin/installed", "plugin/read"]);
  });

  it("reuses one installed snapshot for consecutive configured plugin inventories", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    const calls: Array<{ method: string; params: unknown }> = [];
    const params = {
      pluginConfig: pluginConfig({ github: curatedPlugin("github") }),
      appCacheKey: "runtime",
      configCwd: "/repo/project",
      metadataCache,
      readPluginDetails: false,
      request: async (method: string, requestParams?: unknown) => {
        calls.push({ method, params: requestParams });
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("github")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    };

    const first = await readCodexPluginInventory(params);
    const second = await readCodexPluginInventory(params);

    expect(first.records[0]?.summary.id).toBe("github");
    expect(second.records[0]?.summary.id).toBe("github");
    expect(calls).toEqual([{ method: "plugin/installed", params: { cwds: ["/repo/project"] } }]);
  });

  it("reads the curated catalog only for an explicitly requested missing plugin", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({ calendar: curatedPlugin("calendar") }),
      readPluginDetails: false,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/installed") {
          return pluginInstalled([]);
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("calendar")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toEqual([
      { method: "plugin/installed", params: {} },
      { method: "plugin/list", params: {} },
    ]);
    expect(inventory.records[0]).toMatchObject({
      activationRequired: true,
      summary: { id: "calendar", installed: false },
    });
  });

  it("matches namespaced curated plugin ids by normalized path segment", async () => {
    const appCache = await cachedApps(appInfo("github-app", true));

    const listed = pluginList([
      activePlugin("openai-curated/github", {
        name: "GitHub",
      }),
    ]);
    expect(
      findCodexMarketplacePluginSummary(listed, CODEX_PLUGINS_MARKETPLACE_NAME, "github")?.summary
        .id,
    ).toBe("openai-curated/github");

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({ github: curatedPlugin("github") }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return asPluginInstalled(listed);
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "github",
          });
          return pluginDetail("github", [appSummary("github-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    const record = inventory.records[0];
    expect(record?.policy.pluginName).toBe("github");
    expect(record?.summary.id).toBe("openai-curated/github");
    expect(record?.summary.installed).toBe(true);
    expect(record?.summary.enabled).toBe(true);
    expect(record?.appOwnership).toBe("proven");
    expect(record?.ownedAppIds).toStrictEqual(["github-app"]);
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain(
      "plugin_missing",
    );
  });

  it("accepts the remote curated marketplace wire name", async () => {
    const appCache = await cachedApps(appInfo("google-calendar-app", true));
    const remoteSummary = activePlugin("google-calendar@openai-curated-remote", {
      name: "google-calendar",
      remotePluginId: "plugin_connector_google_calendar",
    });
    const localListed = pluginList([pluginSummary("github")]);
    const listed = {
      ...localListed,
      marketplaces: [
        ...localListed.marketplaces,
        {
          name: "openai-curated-remote",
          path: null,
          interface: null,
          plugins: [remoteSummary],
        },
      ],
    } satisfies v2.PluginListResponse;

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return asPluginInstalled(listed);
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            remoteMarketplaceName: "openai-curated-remote",
            pluginName: "plugin_connector_google_calendar",
          });
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records[0]?.ownedAppIds).toStrictEqual(["google-calendar-app"]);
    expect(inventory.records[0]?.apps[0]?.accessible).toBe(true);
    expect(inventory.diagnostics).toStrictEqual([]);
  });

  it("accepts the API-key curated marketplace wire name", async () => {
    const appCache = await cachedApps(appInfo("google-calendar-app", true));
    const listed = {
      marketplaces: [
        {
          name: "openai-api-curated",
          path: "/codex-home/.tmp/plugins/.agents/plugins/api_marketplace.json",
          interface: null,
          plugins: [
            activePlugin("google-calendar@openai-api-curated", {
              name: "google-calendar",
            }),
          ],
        },
      ],
      marketplaceLoadErrors: [],
    } satisfies v2.PluginInstalledResponse;

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return listed;
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/codex-home/.tmp/plugins/.agents/plugins/api_marketplace.json",
            pluginName: "google-calendar",
          });
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records[0]?.ownedAppIds).toStrictEqual(["google-calendar-app"]);
    expect(inventory.records[0]?.apps[0]?.accessible).toBe(true);
    expect(inventory.diagnostics).toStrictEqual([]);
  });

  it.each(["openai-curated-remote", "openai-api-curated"])(
    "normalizes configured %s aliases to the canonical curated marketplace",
    async (configuredMarketplaceName) => {
      const inventory = await readCodexPluginInventory({
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: {
              github: {
                marketplaceName: configuredMarketplaceName,
                pluginName: "github",
              },
            },
          },
        },
        readPluginDetails: false,
        request: async (method) => {
          if (method === "plugin/installed") {
            return pluginInstalled([pluginSummary("github", { installed: true, enabled: true })]);
          }
          throw new Error(`unexpected request ${method}`);
        },
      });

      expect(inventory.records[0]).toMatchObject({
        policy: { marketplaceName: configuredMarketplaceName },
        summary: { id: "github", installed: true, enabled: true },
      });
      expect(inventory.diagnostics).toEqual([]);
    },
  );

  it("fails closed when an installed remote curated plugin omits its opaque id", async () => {
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      request: async (method) => {
        calls.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              activePlugin("google-calendar@openai-curated-remote", {
                name: "google-calendar",
              }),
            ],
            { name: "openai-curated-remote", path: null },
          );
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toEqual(["plugin/installed"]);
    expect(inventory.records[0]?.detail).toBeUndefined();
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({ code: "plugin_detail_unavailable" }),
    );
  });

  it("resolves an installed workspace plugin from the one canonical installed snapshot", async () => {
    const appCache = await cachedApps(appInfo("workspace-data-app", true));
    const calls: Array<{ method: string; params: unknown }> = [];
    const exactSummary = activePlugin("workspace-data@workspace-directory", {
      name: "Workspace Data",
      remotePluginId: "plugin_workspace_data",
    });

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        workspaceData: workspacePlugin("workspace-data@workspace-directory"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              activePlugin("other-workspace-data@workspace-directory", {
                name: "Workspace Data",
                remotePluginId: "wrong-workspace-data-id",
              }),
              exactSummary,
            ],
            { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null },
          );
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            remoteMarketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
            pluginName: "plugin_workspace_data",
          });
          return pluginDetail("workspace-data", [appSummary("workspace-data-app")], {
            marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
            marketplacePath: null,
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls[0]).toStrictEqual({ method: "plugin/installed", params: {} });
    expect(calls.map((call) => call.method)).not.toContain("plugin/list");
    expect(inventory.records[0]?.summary).toBe(exactSummary);
    expect(inventory.records[0]?.ownedAppIds).toStrictEqual(["workspace-data-app"]);
    expect(inventory.diagnostics).toStrictEqual([]);
  });

  it("uses only the cached installed snapshot for an installed curated plugin", async () => {
    const calls: unknown[] = [];
    await readCodexPluginInventory({
      pluginConfig: pluginConfig({ github: curatedPlugin("github") }),
      readPluginDetails: false,
      request: async (method, params) => {
        if (method === "plugin/installed") {
          calls.push(params);
          return pluginInstalled([activePlugin("github")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toStrictEqual([{}]);
  });

  it("fails closed before plugin/read when a workspace summary lacks remotePluginId", async () => {
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        workspaceData: workspacePlugin("workspace-data@workspace-directory"),
      }),
      request: async (method) => {
        calls.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              activePlugin("workspace-data@workspace-directory", {
                name: "Workspace Data",
              }),
            ],
            { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null },
          );
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toStrictEqual(["plugin/installed"]);
    expect(inventory.records[0]?.detail).toBeUndefined();
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "plugin_detail_unavailable",
    ]);
  });

  it("keeps curated records when a configured workspace marketplace is missing", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        github: curatedPlugin("github"),
        workspaceData: workspacePlugin("workspace-data@workspace-directory"),
      }),
      readPluginDetails: false,
      request: async (method) => {
        if (method !== "plugin/installed") {
          throw new Error(`unexpected request ${method}`);
        }
        return pluginInstalled([activePlugin("github")]);
      },
    });

    expect(inventory.records.map((record) => record.policy.configKey)).toStrictEqual(["github"]);
    expect(inventory.diagnostics).toMatchObject([
      {
        code: "marketplace_missing",
        plugin: { configKey: "workspaceData" },
      },
    ]);
  });

  it("diagnoses every missing workspace owner from the canonical installed snapshot", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        github: curatedPlugin("github"),
        workspaceData: workspacePlugin("workspace-data@workspace-directory"),
        workspaceMetrics: workspacePlugin("workspace-metrics@workspace-directory"),
      }),
      readPluginDetails: false,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method !== "plugin/installed") {
          throw new Error(`unexpected request ${method}`);
        }
        return pluginInstalled([activePlugin("github")]);
      },
    });

    expect(calls).toStrictEqual([{ method: "plugin/installed", params: {} }]);
    expect(inventory.records.map((record) => record.policy.configKey)).toStrictEqual(["github"]);
    expect(
      inventory.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        configKey: diagnostic.plugin?.configKey,
        message: diagnostic.message,
      })),
    ).toStrictEqual([
      {
        code: "marketplace_missing",
        configKey: "workspaceData",
        message: "Codex marketplace workspace-directory was not found.",
      },
      {
        code: "marketplace_missing",
        configKey: "workspaceMetrics",
        message: "Codex marketplace workspace-directory was not found.",
      },
    ]);
  });

  it("does not hide installed-plugin inventory transport failures", async () => {
    const failure = new Error("plugin/installed transport closed");
    await expect(
      readCodexPluginInventory({
        pluginConfig: pluginConfig({
          workspaceData: workspacePlugin("workspace-data@workspace-directory"),
        }),
        readPluginDetails: false,
        request: async (method) => {
          if (method === "plugin/installed") {
            throw failure;
          }
          throw new Error(`unexpected request ${method}`);
        },
      }),
    ).rejects.toBe(failure);
  });

  it("fails closed when plugin detail apps are absent from app inventory", async () => {
    const appCache = await cachedApps();
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("google-calendar")]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    const record = inventory.records[0];
    expect(record?.appOwnership).toBe("proven");
    expect(record?.authRequired).toBe(true);
    expect(record?.ownedAppIds).toStrictEqual(["google-calendar-app"]);
    expect(record?.apps).toStrictEqual([
      {
        id: "google-calendar-app",
        name: "google-calendar-app",
        accessible: false,
        enabled: false,
        needsAuth: true,
      },
    ]);
  });

  it("keeps an authorized disabled plugin app distinct from an authentication failure", async () => {
    const disabledApp = { ...appInfo("google-calendar-app", true), isEnabled: false };
    const appCache = await cachedApps(disabledApp);

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("google-calendar")]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records[0]?.appOwnership).toBe("proven");
    expect(inventory.records[0]?.authRequired).toBe(false);
    expect(inventory.records[0]?.apps).toEqual([
      {
        id: "google-calendar-app",
        name: "google-calendar-app",
        accessible: true,
        enabled: false,
        needsAuth: false,
      },
    ]);
  });

  it("marks display-name-only app matches ambiguous instead of exposing app ids", async () => {
    const appCache = await cachedApps({
      ...appInfo("calendar-app", true),
      pluginDisplayNames: ["Google Calendar"],
    });

    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      readPluginDetails: false,
      request: async (method) => {
        if (method === "plugin/installed") {
          return pluginInstalled([
            activePlugin("google-calendar", {
              name: "Google Calendar",
            }),
          ]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records[0]?.appOwnership).toBe("ambiguous");
    expect(inventory.records[0]?.ownedAppIds).toStrictEqual([]);
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "app_ownership_ambiguous",
    ]);
  });

  it("fails closed when the app inventory cache is missing", async () => {
    const appCache = new CodexAppInventoryCache();
    const inventory = await readCodexPluginInventory({
      pluginConfig: pluginConfig({
        "google-calendar": curatedPlugin("google-calendar"),
      }),
      appCache,
      appCacheKey: "runtime",
      request: async (method) => {
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, []);
        }
        if (method === "plugin/installed") {
          return pluginInstalled([activePlugin("google-calendar")]);
        }
        if (method === "plugin/read") {
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.appInventory?.state).toBe("missing");
    expect(inventory.records[0]?.ownedAppIds).toEqual(["google-calendar-app"]);
    expect(inventory.records[0]?.apps).toStrictEqual([]);
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "app_inventory_missing",
    ]);
  });
});

type ConfiguredPlugin = {
  enabled?: boolean;
  marketplaceName:
    | typeof CODEX_PLUGINS_MARKETPLACE_NAME
    | typeof CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME;
  pluginName: string;
};

function pluginConfig(plugins: Record<string, ConfiguredPlugin>) {
  return { codexPlugins: { enabled: true, plugins } };
}

function curatedPlugin(pluginName: string, options: { enabled?: boolean } = {}): ConfiguredPlugin {
  return { marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME, pluginName, ...options };
}

function workspacePlugin(pluginName: string): ConfiguredPlugin {
  return { marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, pluginName };
}

async function cachedApps(...apps: v2.AppInfo[]): Promise<CodexAppInventoryCache> {
  const cache = new CodexAppInventoryCache();
  await cache.refreshNow({
    key: "runtime",
    nowMs: 0,
    request: async (method, params) => codexAppInventoryResponse(method, apps, params),
  });
  return cache;
}

function activePlugin(id: string, overrides: Partial<v2.PluginSummary> = {}): v2.PluginSummary {
  return pluginSummary(id, { installed: true, enabled: true, ...overrides });
}
