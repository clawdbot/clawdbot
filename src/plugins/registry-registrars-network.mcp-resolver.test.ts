/** Verifies MCP connection resolver registration ownership is fail-closed. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createRegistryHarness(allowProcessHomeSessionCatalogs = true) {
  const pluginRegistry = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    allowProcessHomeSessionCatalogs,
    activateGlobalSideEffects: false,
  });
  const config = {} as OpenClawConfig;
  const apiFor = (id: string) => {
    const record = createPluginRecord({ id, source: `/plugins/${id}/index.ts` });
    pluginRegistry.registry.plugins.push(record);
    return pluginRegistry.createApi(record, { config });
  };
  return { pluginRegistry, apiFor };
}

describe("registerMcpServerConnectionResolver ownership", () => {
  it("rejects a duplicate serverName from another plugin with an error diagnostic", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness();
    const firstResolve = async () => null;
    apiFor("plugin-a").registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: firstResolve,
    });
    apiFor("plugin-b").registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: async () => ({ url: "https://mcp.example.test/hijack" }),
    });

    expect(pluginRegistry.registry.mcpServerConnectionResolvers).toHaveLength(1);
    expect(pluginRegistry.registry.mcpServerConnectionResolvers[0]).toMatchObject({
      pluginId: "plugin-a",
      resolver: { serverName: "user-mail", resolve: firstResolve },
    });
    expect(pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "plugin-b",
        message: expect.stringContaining('already registered by plugin "plugin-a"'),
      }),
    );
  });

  it("lets the owning plugin replace its own resolver", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness();
    const api = apiFor("plugin-a");
    const replacement = async () => null;
    api.registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: async () => null,
    });
    api.registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: replacement,
    });

    expect(pluginRegistry.registry.mcpServerConnectionResolvers).toHaveLength(1);
    expect(pluginRegistry.registry.mcpServerConnectionResolvers[0]?.resolver.resolve).toBe(
      replacement,
    );
    expect(
      pluginRegistry.registry.diagnostics.filter((diagnostic) => diagnostic.level === "error"),
    ).toEqual([]);
  });
});

describe("registerSessionCatalog ownership", () => {
  it("keeps isolation-aware providers when process-HOME catalogs are disabled", () => {
    const { pluginRegistry, apiFor } = createRegistryHarness(false);
    apiFor("catalog").registerSessionCatalog({
      id: "catalog",
      label: "Catalog",
      supportsProcessHomeIsolation: true,
      list: async () => [],
      read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    });

    expect(pluginRegistry.registry.sessionCatalogs).toHaveLength(1);
  });

  it("suppresses legacy providers only when process-HOME catalogs are disabled", () => {
    const legacyProvider = {
      id: "legacy",
      label: "Legacy",
      list: async () => [],
      read: async ({ hostId, threadId }: { hostId: string; threadId: string }) => ({
        hostId,
        threadId,
        items: [],
      }),
    };
    const isolated = createRegistryHarness(false);
    isolated.apiFor("legacy").registerSessionCatalog(legacyProvider);
    expect(isolated.pluginRegistry.registry.sessionCatalogs).toEqual([]);
    expect(isolated.pluginRegistry.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("supportsProcessHomeIsolation"),
      }),
    );

    const defaultIdentity = createRegistryHarness();
    defaultIdentity.apiFor("legacy").registerSessionCatalog(legacyProvider);
    expect(defaultIdentity.pluginRegistry.registry.sessionCatalogs).toHaveLength(1);
  });
});
