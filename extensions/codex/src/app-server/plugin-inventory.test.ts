// Codex tests cover plugin inventory plugin behavior.
import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CodexAppServerRpcError } from "./client.js";
import {
  CODEX_PLUGINS_MARKETPLACE_NAME,
  CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
} from "./config.js";
import { findOpenAiCuratedPluginSummary, readCodexPluginInventory } from "./plugin-inventory.js";
import type { v2 } from "./protocol.js";

describe("Codex plugin inventory", () => {
  it("returns enabled migrated curated plugins with stable owned app ids", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [appInfo("google-calendar-app", true)],
        nextCursor: null,
      }),
    });
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
            slack: {
              enabled: false,
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "slack",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", { installed: true, enabled: true }),
            pluginSummary("slack", { installed: true, enabled: true }),
          ]);
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
    expect(calls).toEqual(["plugin/list", "plugin/read"]);
  });

  it("matches namespaced curated plugin ids by normalized path segment", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [appInfo("github-app", true)],
        nextCursor: null,
      }),
    });

    const listed = pluginList([
      pluginSummary("openai-curated/github", {
        name: "GitHub",
        installed: true,
        enabled: true,
      }),
    ]);
    expect(findOpenAiCuratedPluginSummary(listed, "github")?.summary.id).toBe(
      "openai-curated/github",
    );

    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            github: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "github",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/list") {
          return listed;
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
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [appInfo("google-calendar-app", true)],
        nextCursor: null,
      }),
    });
    const remoteSummary = pluginSummary("google-calendar@openai-curated-remote", {
      name: "google-calendar",
      remotePluginId: "plugin_connector_google_calendar",
      installed: true,
      enabled: true,
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
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        if (method === "plugin/list") {
          return listed;
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

  it("queries workspace-directory only when configured and resolves the exact catalog id", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({ data: [appInfo("workspace-data-app", true)], nextCursor: null }),
    });
    const calls: Array<{ method: string; params: unknown }> = [];
    const exactSummary = pluginSummary("workspace-data@workspace-directory", {
      name: "Workspace Data",
      remotePluginId: "plugin_workspace_data",
      installed: true,
      enabled: true,
    });

    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            workspaceData: {
              marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
              pluginName: "workspace-data@workspace-directory",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/list" && !(params as v2.PluginListParams).marketplaceKinds) {
          return pluginList([]);
        }
        if (method === "plugin/list") {
          return pluginList(
            [
              pluginSummary("other-workspace-data@workspace-directory", {
                name: "Workspace Data",
                remotePluginId: "wrong-workspace-data-id",
                installed: true,
                enabled: true,
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

    expect(calls.slice(0, 2)).toStrictEqual([
      { method: "plugin/list", params: {} },
      {
        method: "plugin/list",
        params: { cwds: [], marketplaceKinds: [CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME] },
      },
    ]);
    expect(inventory.records[0]?.summary).toBe(exactSummary);
    expect(inventory.records[0]?.ownedAppIds).toStrictEqual(["workspace-data-app"]);
    expect(inventory.diagnostics).toStrictEqual([]);
  });

  it("does not query workspace-directory for curated-only policy", async () => {
    const calls: unknown[] = [];
    await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            github: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "github",
            },
          },
        },
      },
      readPluginDetails: false,
      request: async (method, params) => {
        if (method === "plugin/list") {
          calls.push(params);
          return pluginList([pluginSummary("github", { installed: true, enabled: true })]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toStrictEqual([{}]);
  });

  it("fails closed before plugin/read when a workspace summary lacks remotePluginId", async () => {
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            workspaceData: {
              marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
              pluginName: "workspace-data@workspace-directory",
            },
          },
        },
      },
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/list" && !(params as v2.PluginListParams).marketplaceKinds) {
          return pluginList([]);
        }
        if (method === "plugin/list") {
          return pluginList(
            [
              pluginSummary("workspace-data@workspace-directory", {
                name: "Workspace Data",
                installed: true,
                enabled: true,
              }),
            ],
            { name: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME, path: null },
          );
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toStrictEqual(["plugin/list", "plugin/list"]);
    expect(inventory.records[0]?.detail).toBeUndefined();
    expect(inventory.diagnostics.map((diagnostic) => diagnostic.code)).toStrictEqual([
      "plugin_detail_unavailable",
    ]);
  });

  it("keeps curated records when a configured workspace marketplace is missing", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            github: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "github",
            },
            workspaceData: {
              marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
              pluginName: "workspace-data@workspace-directory",
            },
          },
        },
      },
      readPluginDetails: false,
      request: async (method, params) => {
        if (method !== "plugin/list") {
          throw new Error(`unexpected request ${method}`);
        }
        return (params as v2.PluginListParams).marketplaceKinds
          ? { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
          : pluginList([pluginSummary("github", { installed: true, enabled: true })]);
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

  it("keeps curated records and diagnoses each workspace plugin when its explicit list is rejected", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            github: {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "github",
            },
            workspaceData: {
              marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
              pluginName: "workspace-data@workspace-directory",
            },
            workspaceMetrics: {
              marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
              pluginName: "workspace-metrics@workspace-directory",
            },
          },
        },
      },
      readPluginDetails: false,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method !== "plugin/list") {
          throw new Error(`unexpected request ${method}`);
        }
        if ((params as v2.PluginListParams).marketplaceKinds) {
          throw new CodexAppServerRpcError(
            { code: -32_603, message: "list remote plugin catalog failed" },
            method,
          );
        }
        return pluginList([pluginSummary("github", { installed: true, enabled: true })]);
      },
    });

    expect(calls).toStrictEqual([
      { method: "plugin/list", params: {} },
      {
        method: "plugin/list",
        params: { cwds: [], marketplaceKinds: [CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME] },
      },
    ]);
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

  it("does not hide non-RPC failures from the explicit workspace list", async () => {
    const failure = new Error("workspace plugin/list transport closed");
    await expect(
      readCodexPluginInventory({
        pluginConfig: {
          codexPlugins: {
            enabled: true,
            plugins: {
              workspaceData: {
                marketplaceName: CODEX_PLUGINS_WORKSPACE_MARKETPLACE_NAME,
                pluginName: "workspace-data@workspace-directory",
              },
            },
          },
        },
        readPluginDetails: false,
        request: async (method, params) => {
          if (method !== "plugin/list") {
            throw new Error(`unexpected request ${method}`);
          }
          if ((params as v2.PluginListParams).marketplaceKinds) {
            throw failure;
          }
          return pluginList([]);
        },
      }),
    ).rejects.toBe(failure);
  });

  it("fails closed when plugin detail apps are absent from app inventory", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [],
        nextCursor: null,
      }),
    });
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      request: async (method) => {
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
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

  it("marks display-name-only app matches ambiguous instead of exposing app ids", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async () => ({
        data: [
          {
            ...appInfo("calendar-app", true),
            pluginDisplayNames: ["Google Calendar"],
          },
        ],
        nextCursor: null,
      }),
    });

    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      nowMs: 1,
      readPluginDetails: false,
      request: async (method) => {
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", {
              name: "Google Calendar",
              installed: true,
              enabled: true,
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
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "google-calendar": {
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      request: async (method) => {
        if (method === "app/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "plugin/list") {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
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

function pluginList(
  plugins: v2.PluginSummary[],
  marketplace: { name?: string; path?: string | null } = {},
): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: marketplace.name ?? CODEX_PLUGINS_MARKETPLACE_NAME,
        path: marketplace.path === undefined ? "/marketplaces/openai-curated" : marketplace.path,
        interface: null,
        plugins,
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function pluginSummary(id: string, overrides: Partial<v2.PluginSummary> = {}): v2.PluginSummary {
  return {
    id,
    name: id,
    source: { type: "remote" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    interface: null,
    ...overrides,
  };
}

function pluginDetail(
  pluginName: string,
  apps: v2.AppSummary[],
  marketplace: { marketplaceName?: string; marketplacePath?: string | null } = {},
): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: marketplace.marketplaceName ?? CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath:
        marketplace.marketplacePath === undefined
          ? "/marketplaces/openai-curated"
          : marketplace.marketplacePath,
      summary: pluginSummary(pluginName, { installed: true, enabled: true }),
      description: null,
      skills: [],
      apps,
      mcpServers: [],
    },
  };
}

function appSummary(id: string): v2.AppSummary {
  return {
    id,
    name: id,
    description: null,
    installUrl: null,
    needsAuth: false,
  };
}

function appInfo(id: string, accessible: boolean): v2.AppInfo {
  return {
    id,
    name: id,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: accessible,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}
