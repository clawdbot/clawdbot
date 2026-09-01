// Codex tests cover marketplace-qualified plugin inventory behavior.
import { describe, expect, it } from "vitest";
import { CodexAppInventoryCache } from "./app-inventory-cache.js";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { readCodexPluginInventory } from "./plugin-inventory.js";
import {
  appInfo,
  appSummary,
  pluginDetail,
  pluginInstalled,
  pluginList,
  pluginSummary,
} from "./plugin-inventory.test-helpers.js";
import { CodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { v2 } from "./protocol.js";

describe("Codex marketplace-qualified plugin inventory", () => {
  it("resolves an owner-installed repository plugin from its exact marketplace", async () => {
    const appCache = new CodexAppInventoryCache();
    await appCache.refreshNow({
      key: "runtime",
      nowMs: 0,
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("github-app", true)], params),
    });
    const calls: Array<{ method: string; params: unknown }> = [];

    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "security-review@company-tools": {
              marketplaceName: "company-tools",
              pluginName: "security-review",
            },
          },
        },
      },
      appCache,
      appCacheKey: "runtime",
      configCwd: "/repo/company",
      nowMs: 1,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              pluginSummary("security-review@company-tools", {
                name: "security-review",
                installed: true,
                enabled: true,
              }),
            ],
            { name: "company-tools", path: "/repo/company/.agents/plugins/marketplace.json" },
          );
        }
        if (method === "plugin/read") {
          return pluginDetail("security-review", [appSummary("github-app")], {
            marketplaceName: "company-tools",
            marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toEqual([
      { method: "plugin/installed", params: { cwds: ["/repo/company"] } },
      {
        method: "plugin/read",
        params: {
          marketplacePath: "/repo/company/.agents/plugins/marketplace.json",
          pluginName: "security-review",
        },
      },
    ]);
    expect(inventory.records[0]).toMatchObject({
      policy: { marketplaceName: "company-tools", pluginName: "security-review" },
      activationRequired: false,
      ownedAppIds: ["github-app"],
    });
  });

  it("never admits the same plugin name from a different marketplace", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "audit@trusted-company": {
              marketplaceName: "trusted-company",
              pluginName: "audit",
            },
          },
        },
      },
      configCwd: "/repo/company",
      readPluginDetails: false,
      request: async (method, params) => {
        expect(params).toEqual({ cwds: ["/repo/company"] });
        if (method === "plugin/installed" || method === "plugin/list") {
          const marketplace = {
            name: "untrusted-company",
            path: "/repo/untrusted/.agents/plugins/marketplace.json",
            interface: null,
            plugins: [pluginSummary("audit", { installed: true, enabled: true })],
          };
          return method === "plugin/installed"
            ? { marketplaces: [marketplace], marketplaceLoadErrors: [] }
            : { marketplaces: [marketplace], marketplaceLoadErrors: [], featuredPluginIds: [] };
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toEqual([]);
    expect(inventory.diagnostics).toEqual([
      expect.objectContaining({ code: "marketplace_missing" }),
    ]);
  });

  it("selects the authorized marketplace when two catalogs contain the same plugin name", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "audit@trusted-company": {
              marketplaceName: "trusted-company",
              pluginName: "audit",
            },
          },
        },
      },
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return {
            marketplaces: [
              {
                name: "untrusted-company",
                path: "/untrusted/marketplace.json",
                interface: null,
                plugins: [pluginSummary("audit", { installed: true, enabled: true })],
              },
              {
                name: "trusted-company",
                path: "/trusted/marketplace.json",
                interface: null,
                plugins: [pluginSummary("audit", { installed: true, enabled: true })],
              },
            ],
            marketplaceLoadErrors: [],
          } satisfies v2.PluginInstalledResponse;
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/trusted/marketplace.json",
            pluginName: "audit",
          });
          return pluginDetail("audit", [], {
            marketplaceName: "trusted-company",
            marketplacePath: "/trusted/marketplace.json",
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records).toHaveLength(1);
    expect(inventory.records[0]?.policy.marketplaceName).toBe("trusted-company");
  });

  it("discovers an uninstalled repository plugin with its current conversation cwd", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "security-review@company-tools": {
              marketplaceName: "company-tools",
              pluginName: "security-review",
            },
          },
        },
      },
      configCwd: "/repo/company",
      readPluginDetails: false,
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === "plugin/installed") {
          return {
            marketplaces: [],
            marketplaceLoadErrors: [],
          } satisfies v2.PluginInstalledResponse;
        }
        if (method === "plugin/list") {
          return pluginList(
            [pluginSummary("security-review", { installed: false, enabled: false })],
            {
              name: "company-tools",
              path: "/repo/company/.agents/plugins/marketplace.json",
            },
          );
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toEqual([
      { method: "plugin/installed", params: { cwds: ["/repo/company"] } },
      { method: "plugin/list", params: { cwds: ["/repo/company"] } },
    ]);
    expect(inventory.records[0]).toMatchObject({
      policy: { marketplaceName: "company-tools" },
      activationRequired: true,
    });
  });

  it("uses the opaque remote id for installed shared-marketplace plugins", async () => {
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "audit@workspace-shared-with-me": {
              marketplaceName: "workspace-shared-with-me",
              pluginName: "audit@workspace-shared-with-me",
            },
          },
        },
      },
      request: async (method, params) => {
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              pluginSummary("audit@workspace-shared-with-me", {
                name: "audit",
                remotePluginId: "plugin_shared_audit_opaque",
                installed: true,
                enabled: true,
              }),
            ],
            { name: "workspace-shared-with-me", path: null },
          );
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            remoteMarketplaceName: "workspace-shared-with-me",
            pluginName: "plugin_shared_audit_opaque",
          });
          return pluginDetail("audit", [], {
            marketplaceName: "workspace-shared-with-me",
            marketplacePath: null,
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(inventory.records[0]?.summary.remotePluginId).toBe("plugin_shared_audit_opaque");
    expect(inventory.diagnostics).toEqual([]);
  });

  it("does not reuse a partial repository catalog when resolving the curated marketplace", async () => {
    const metadataCache = new CodexPluginMetadataCache();
    let catalogCalls = 0;
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "a-security": {
              marketplaceName: "company-tools",
              pluginName: "security-review",
            },
            "z-calendar": {
              marketplaceName: "openai-curated",
              pluginName: "calendar",
            },
          },
        },
      },
      appCacheKey: "runtime",
      configCwd: "/repo/company",
      metadataCache,
      readPluginDetails: false,
      request: async (method) => {
        if (method === "plugin/installed") {
          return { marketplaces: [], marketplaceLoadErrors: [] };
        }
        if (method === "plugin/list") {
          catalogCalls += 1;
          return catalogCalls === 1
            ? pluginList([pluginSummary("security-review")], {
                name: "company-tools",
                path: "/repo/company/.agents/plugins/marketplace.json",
              })
            : pluginList([pluginSummary("calendar")], {
                name: "openai-curated",
                path: "/managed/openai-curated/marketplace.json",
              });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(catalogCalls).toBe(2);
    expect(inventory.records.map((record) => record.policy.configKey)).toEqual([
      "a-security",
      "z-calendar",
    ]);
    expect(inventory.diagnostics).toEqual([]);
  });

  it("never exposes plugins disabled by an administrator", async () => {
    const calls: string[] = [];
    const inventory = await readCodexPluginInventory({
      pluginConfig: {
        codexPlugins: {
          enabled: true,
          plugins: {
            "audit@enterprise": {
              marketplaceName: "enterprise",
              pluginName: "audit",
            },
          },
        },
      },
      request: async (method, params) => {
        calls.push(method);
        if (method === "plugin/installed") {
          return pluginInstalled(
            [
              pluginSummary("audit", {
                installed: true,
                enabled: true,
                availability: "DISABLED_BY_ADMIN",
              }),
            ],
            { name: "enterprise", path: "/enterprise/marketplace.json" },
          );
        }
        if (method === "plugin/read") {
          expect(params).toEqual({
            marketplacePath: "/enterprise/marketplace.json",
            pluginName: "audit",
          });
          return pluginDetail("audit", [appSummary("admin-denied-app")], {
            marketplaceName: "enterprise",
            marketplacePath: "/enterprise/marketplace.json",
          });
        }
        throw new Error(`unexpected request ${method}`);
      },
    });

    expect(calls).toEqual(["plugin/installed", "plugin/read"]);
    expect(inventory.records[0]).toMatchObject({
      activationRequired: true,
      ownedAppIds: ["admin-denied-app"],
    });
    expect(inventory.diagnostics).toEqual([expect.objectContaining({ code: "plugin_disabled" })]);
  });
});
