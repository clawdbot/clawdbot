// Verifies plugin control-plane context construction and boundaries.
import { describe, expect, it } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";

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
});
