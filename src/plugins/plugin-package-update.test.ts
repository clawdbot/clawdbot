import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import {
  capturePluginPackageUpdateSnapshot,
  pluginPackageUpdateMayMutateConfig,
  reconcilePluginPackageUpdateConfig,
} from "./plugin-package-update.js";

function record(
  pluginId: string,
  rootDir: string,
  contributions: { channels?: string[]; channelConfigs?: string[] } = {},
): InstalledPluginIndexRecord {
  return recordInstalledPluginIndexInstallOwner(
    {
      pluginId,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
      manifestHash: pluginId,
      source: `${rootDir}/${pluginId.split("/").at(-1)}.js`,
      rootDir,
      origin: "global",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      contributions: {
        channels: contributions.channels ?? [],
        channelConfigs: contributions.channelConfigs ?? [],
        providers: [],
        modelCatalogProviders: [],
        modelSupportPrefixes: [],
        modelSupportPatterns: [],
        autoEnableProviderIds: [],
        commandAliases: [],
        contracts: {},
      },
      compat: [],
    },
    "pack",
  );
}

function index(rootDir: string, plugins: InstalledPluginIndexRecord[]): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {
      pack: { source: "npm", installPath: rootDir, spec: "@openclaw/pack@latest" },
    },
    plugins,
    diagnostics: [],
  };
}

describe("plugin package update policy reconciliation", () => {
  it("removes retired child policy while preserving retained, new, and unrelated state", () => {
    const beforeRoot = "/packages/pack-v1";
    const afterRoot = "/packages/pack-v2";
    const before = index(beforeRoot, [
      record("pack/one", beforeRoot, { channels: ["shared"] }),
      record("pack/two", beforeRoot, { channels: ["two-channel", "shared"] }),
      record("pack/old", beforeRoot, { channelConfigs: ["old-config"] }),
    ]);
    const after = index(afterRoot, [
      record("pack/one", afterRoot, { channels: ["shared"] }),
      record("pack/renamed", afterRoot),
    ]);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const config: OpenClawConfig = {
      plugins: {
        allow: ["pack/one", "pack/two", "pack/old", "other"],
        deny: ["pack/two", "pack/old", "other-denied"],
        entries: {
          "pack/one": { enabled: true },
          "pack/two": { enabled: false },
          "pack/old": { enabled: true },
          other: { enabled: true },
        },
        load: {
          paths: [`${beforeRoot}/two.js`, `${beforeRoot}/old.js`, "/plugins/unrelated.js"],
        },
        slots: { memory: "pack/two", contextEngine: "pack/old" },
      },
      channels: {
        "two-channel": { enabled: true },
        "old-config": { enabled: true },
        shared: { enabled: true },
        discord: { enabled: true },
      },
    };

    const result = reconcilePluginPackageUpdateConfig({
      config,
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.plugins).toEqual({
      allow: ["pack/one", "other"],
      deny: ["other-denied"],
      entries: { "pack/one": { enabled: true }, other: { enabled: true } },
      load: { paths: ["/plugins/unrelated.js"] },
    });
    expect(result.config.channels).toEqual({
      shared: { enabled: true },
      discord: { enabled: true },
    });
  });

  it("fails closed when the replacement package has no authoritative child rows", () => {
    const before = index("/packages/pack-v1", [record("pack/one", "/packages/pack-v1")]);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const result = reconcilePluginPackageUpdateConfig({
      config: { plugins: { entries: { "pack/one": { enabled: true } } } },
      beforeIndex: before,
      afterIndex: index("/packages/pack-v2", []),
      snapshot: snapshot.value,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("skips an exact tombstone while reconciling another package update", () => {
    const orphanRecord = {
      source: "path",
      sourcePath: "/missing/orphan-source",
      installPath: "/missing/orphan-install",
    } as const;
    const beforePack = index("/packages/pack-v1", [record("pack/one", "/packages/pack-v1")]);
    const afterPack = index("/packages/pack-v2", [record("pack/one", "/packages/pack-v2")]);
    const before = {
      ...beforePack,
      installRecords: { orphan: orphanRecord, ...beforePack.installRecords },
    };
    const after = {
      ...afterPack,
      installRecords: { orphan: orphanRecord, ...afterPack.installRecords },
    };
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["orphan", "pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const config = { plugins: { entries: { "pack/one": { enabled: true } } } };

    const result = reconcilePluginPackageUpdateConfig({
      config,
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
    });

    expect(result).toEqual({ ok: true, config });
  });

  it("fails closed when a tombstone replacement still has no authoritative child rows", () => {
    const before = index("/packages/pack-v1", []);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const after = {
      ...index("/packages/pack-v2", []),
      installRecords: {
        pack: {
          ...before.installRecords.pack!,
          installPath: "/packages/pack-v2",
          version: "2.0.0",
        },
      },
    };

    const result = reconcilePluginPackageUpdateConfig({
      config: {},
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("accepts a valid package restored from an exact tombstone", () => {
    const before = index("/packages/pack-v1", []);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const after = index("/packages/pack-v2", [record("pack/one", "/packages/pack-v2")]);

    const result = reconcilePluginPackageUpdateConfig({
      config: {},
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
    });

    expect(result).toEqual({ ok: true, config: {} });
  });

  it("follows catalog-alias install-owner migrations without pruning QQ config", () => {
    const rootDir = "/packages/qqbot";
    const before: InstalledPluginIndex = {
      ...index(rootDir, [record("qqbot", rootDir, { channels: ["qqbot"] })]),
      installRecords: {
        qqbot: { source: "npm", installPath: rootDir, spec: "@openclaw/qqbot@1.9.0" },
        "openclaw-qqbot": {
          source: "npm",
          installPath: `${rootDir}-canonical`,
          spec: "@tencent-connect/openclaw-qqbot@2.0.1",
        },
      },
    };
    before.plugins = [
      recordInstalledPluginIndexInstallOwner(
        record("qqbot", rootDir, { channels: ["qqbot"] }),
        "qqbot",
      ),
    ];
    const after: InstalledPluginIndex = {
      ...index(`${rootDir}-canonical`, [
        record("openclaw-qqbot", `${rootDir}-canonical`, { channels: ["qqbot"] }),
      ]),
      installRecords: {
        "openclaw-qqbot": {
          source: "npm",
          installPath: `${rootDir}-canonical`,
          spec: "@tencent-connect/openclaw-qqbot@2.0.3",
        },
      },
    };
    after.plugins = [
      recordInstalledPluginIndexInstallOwner(
        record("openclaw-qqbot", `${rootDir}-canonical`, { channels: ["qqbot"] }),
        "openclaw-qqbot",
      ),
    ];
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["qqbot"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const qqbotConfig = {
      enabled: true,
      appId: "root-app",
      clientSecret: "root-secret",
      accounts: {
        primary: { appId: "primary-app", clientSecret: "primary-secret" },
        secondary: { appId: "secondary-app", clientSecret: "secondary-secret" },
      },
    };
    const config = {
      channels: { qqbot: qqbotConfig },
      plugins: {
        load: { paths: [rootDir, `${rootDir}/qqbot.js`, "/plugins/unrelated.js"] },
      },
    } satisfies OpenClawConfig;
    const missingMigration = reconcilePluginPackageUpdateConfig({
      config,
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
    });
    expect(missingMigration).toMatchObject({ ok: false });
    if (missingMigration.ok) {
      throw new Error("expected missing alias migration to fail");
    }
    expect(missingMigration.error).toContain(
      'Plugin "qqbot" is not associated with a tracked package install',
    );
    const migrated = reconcilePluginPackageUpdateConfig({
      config,
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
      installOwnerMigrations: { qqbot: "openclaw-qqbot" },
    });
    expect(migrated).toMatchObject({ ok: true });
    if (!migrated.ok) {
      throw new Error(migrated.error);
    }
    expect(migrated.config.channels?.qqbot).toEqual(qqbotConfig);
    expect(migrated.config.plugins?.load?.paths).toEqual(["/plugins/unrelated.js"]);
  });

  it("keeps a shared package root while removing a retired child entry path", () => {
    const rootDir = "/packages/shared-pack";
    const before = index(rootDir, [record("pack/one", rootDir), record("pack/old", rootDir)]);
    const after = index(rootDir, [record("pack/one", rootDir)]);
    const snapshot = capturePluginPackageUpdateSnapshot({
      index: before,
      installOwners: ["pack"],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error(snapshot.error);
    }
    const result = reconcilePluginPackageUpdateConfig({
      config: {
        plugins: {
          load: { paths: [rootDir, `${rootDir}/old.js`, "/plugins/unrelated.js"] },
        },
      },
      beforeIndex: before,
      afterIndex: after,
      snapshot: snapshot.value,
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.config.plugins?.load?.paths).toEqual([rootDir, "/plugins/unrelated.js"]);
  });

  it.each(["entry", "root"])(
    "detects exact %s load-path cleanup before an update starts",
    (kind) => {
      const rootDir = "/packages/pack-v1";
      const before = index(rootDir, [record("pack/one", rootDir)]);
      const snapshot = capturePluginPackageUpdateSnapshot({
        index: before,
        installOwners: ["pack"],
      });
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) {
        throw new Error(snapshot.error);
      }
      expect(
        pluginPackageUpdateMayMutateConfig({
          config: {
            plugins: { load: { paths: [kind === "entry" ? `${rootDir}/one.js` : rootDir] } },
          },
          index: before,
          snapshot: snapshot.value,
        }),
      ).toBe(true);
    },
  );
});
