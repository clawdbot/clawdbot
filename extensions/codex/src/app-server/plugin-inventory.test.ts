import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "./config.js";
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
          expect(params).toMatchObject({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "google-calendar",
          });
          return pluginDetail("google-calendar", [appSummary("google-calendar-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    expect(inventory.records[0]).toMatchObject({
      policy: { pluginName: "google-calendar" },
      summary: { installed: true, enabled: true },
      appOwnership: "proven",
      ownedAppIds: ["google-calendar-app"],
      apps: [{ id: "google-calendar-app", accessible: true, enabled: true }],
    });
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
          expect(params).toMatchObject({
            marketplacePath: "/marketplaces/openai-curated",
            pluginName: "github",
          });
          return pluginDetail("github", [appSummary("github-app")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    expect(inventory.records[0]).toMatchObject({
      policy: { pluginName: "github" },
      summary: { id: "openai-curated/github", installed: true, enabled: true },
      appOwnership: "proven",
      ownedAppIds: ["github-app"],
    });
    expect(inventory.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "plugin_missing" }),
    );
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

    expect(inventory.records[0]).toMatchObject({
      appOwnership: "proven",
      authRequired: true,
      ownedAppIds: ["google-calendar-app"],
      apps: [
        {
          id: "google-calendar-app",
          accessible: false,
          enabled: false,
          needsAuth: true,
        },
      ],
    });
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
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({ code: "app_ownership_ambiguous" }),
    );
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
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({ code: "app_inventory_missing" }),
    );
  });
});

function pluginList(plugins: v2.PluginSummary[]): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: CODEX_PLUGINS_MARKETPLACE_NAME,
        path: "/marketplaces/openai-curated",
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

function pluginDetail(pluginName: string, apps: v2.AppSummary[]): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath: "/marketplaces/openai-curated",
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
