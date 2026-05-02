import { describe, expect, it } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  resolvePluginControlPlaneContext,
  resolvePluginControlPlaneFingerprint,
  resolvePluginDiscoveryContext,
  resolvePluginDiscoveryFingerprint,
} from "./plugin-control-plane-context.js";

function createIndex(pluginId: string): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
    generatedAtMs: 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId,
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest-hash`,
        rootDir: `/plugins/${pluginId}`,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  };
}

describe("plugin control-plane context", () => {
  it("resolves env-sensitive discovery roots and load paths before fingerprinting", () => {
    const config = { plugins: { load: { paths: ["~/plugins", "/opt/shared"] } } };
    const envA = { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" } as NodeJS.ProcessEnv;
    const envB = { HOME: "/home/b", OPENCLAW_HOME: "/openclaw/b" } as NodeJS.ProcessEnv;

    const contextA = resolvePluginDiscoveryContext({ config, env: envA });
    const contextB = resolvePluginDiscoveryContext({ config, env: envB });

    expect(contextA.loadPaths).toEqual(["/openclaw/a/plugins", "/opt/shared"]);
    expect(contextB.loadPaths).toEqual(["/openclaw/b/plugins", "/opt/shared"]);
    expect(resolvePluginDiscoveryFingerprint({ config, env: envA })).not.toBe(
      resolvePluginDiscoveryFingerprint({ config, env: envB }),
    );
  });

  it("includes policy, inventory, and activation in one control-plane fingerprint", () => {
    const config = { plugins: { allow: ["demo"] } };
    const base = resolvePluginControlPlaneFingerprint({
      config,
      env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" } as NodeJS.ProcessEnv,
      index: createIndex("demo"),
      activationFingerprint: "activation-a",
    });

    expect(
      resolvePluginControlPlaneFingerprint({
        config,
        env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" } as NodeJS.ProcessEnv,
        index: createIndex("other"),
        activationFingerprint: "activation-a",
      }),
    ).not.toBe(base);
    expect(
      resolvePluginControlPlaneFingerprint({
        config,
        env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" } as NodeJS.ProcessEnv,
        index: createIndex("demo"),
        activationFingerprint: "activation-b",
      }),
    ).not.toBe(base);
    expect(
      resolvePluginControlPlaneFingerprint({
        config: { plugins: { deny: ["demo"] } },
        env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" } as NodeJS.ProcessEnv,
        index: createIndex("demo"),
        activationFingerprint: "activation-a",
      }),
    ).not.toBe(base);
  });

  it("keeps the canonical context inspectable for cache diagnostics", () => {
    const context = resolvePluginControlPlaneContext({
      config: { plugins: { load: { paths: ["/opt/plugins"] } } },
      env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" } as NodeJS.ProcessEnv,
      inventoryFingerprint: "inventory",
      policyHash: "policy",
    });

    expect(context).toMatchObject({
      discovery: {
        loadPaths: ["/opt/plugins"],
        roots: {
          global: "/openclaw/a/.openclaw/extensions",
        },
      },
      inventoryFingerprint: "inventory",
      policyFingerprint: "policy",
    });
  });
});
