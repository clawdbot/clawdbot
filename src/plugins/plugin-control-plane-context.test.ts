// Verifies plugin control-plane context construction and boundaries.
import { describe, expect, it } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";

function createIndex(
  pluginId: string,
  options: {
    doctorContractFile?: InstalledPluginIndex["plugins"][number]["doctorContractFile"];
    doctorContractHash?: string;
    generatedAtMs?: number;
  } = {},
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
    generatedAtMs: options.generatedAtMs ?? 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId,
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest-hash`,
        ...(options.doctorContractHash ? { doctorContractHash: options.doctorContractHash } : {}),
        ...(options.doctorContractFile ? { doctorContractFile: options.doctorContractFile } : {}),
        rootDir: `/plugins/${pluginId}`,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
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

  it("tracks doctor contract content but ignores index generation time", () => {
    const baseIndex = createIndex("demo", {
      doctorContractHash: "contract-a",
      generatedAtMs: 1,
    });
    const changedContractIndex = createIndex("demo", {
      doctorContractHash: "contract-b",
      generatedAtMs: 1,
    });
    const regeneratedIndex = createIndex("demo", {
      doctorContractHash: "contract-a",
      generatedAtMs: 2,
    });
    const retimedContractIndex = createIndex("demo", {
      doctorContractHash: "contract-a",
      doctorContractFile: { size: 10, mtimeMs: 20, ctimeMs: 30 },
      generatedAtMs: 1,
    });
    const resolveControlPlaneFingerprint = (index: InstalledPluginIndex) =>
      resolvePluginControlPlaneFingerprint({
        config: { plugins: { allow: ["demo"] } },
        env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" } as NodeJS.ProcessEnv,
        index,
        activationFingerprint: "activation-a",
      });

    const inventoryFingerprint = resolveInstalledManifestRegistryIndexFingerprint(baseIndex);
    expect(resolveInstalledManifestRegistryIndexFingerprint(changedContractIndex)).not.toBe(
      inventoryFingerprint,
    );
    expect(resolveInstalledManifestRegistryIndexFingerprint(regeneratedIndex)).toBe(
      inventoryFingerprint,
    );
    expect(resolveInstalledManifestRegistryIndexFingerprint(retimedContractIndex)).toBe(
      inventoryFingerprint,
    );

    const controlPlaneFingerprint = resolveControlPlaneFingerprint(baseIndex);
    expect(resolveControlPlaneFingerprint(changedContractIndex)).not.toBe(controlPlaneFingerprint);
    expect(resolveControlPlaneFingerprint(regeneratedIndex)).toBe(controlPlaneFingerprint);
    expect(resolveControlPlaneFingerprint(retimedContractIndex)).toBe(controlPlaneFingerprint);
  });
});
