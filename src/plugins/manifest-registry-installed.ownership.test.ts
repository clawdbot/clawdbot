// Covers persisted installed package ownership and phase-local path validation.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordInstalledPluginIndexInstallOwner,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import {
  hasMissingInstalledPluginOwnerMetadata,
  createInstalledPluginOwnershipResolver,
} from "./installed-plugin-package-ownership.js";
import { resolvePluginManifestInstallOwner } from "./manifest-install-owner.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { createIndex } from "./manifest-registry-installed.test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-manifest-registry", tempDirs);
}

describe("loadPluginManifestRegistryForInstalledIndex", () => {
  it("preserves package entry identities through a persisted cold reload", async () => {
    const stateDir = makeTempDir();
    const packageDir = path.join(stateDir, "extensions", "pack");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "pack",
        version: "1.0.0",
        openclaw: { extensions: ["./one.cjs", "./two.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "pack", configSchema: { type: "object" } }),
      "utf8",
    );
    for (const entry of ["one", "two"]) {
      fs.writeFileSync(
        path.join(packageDir, `${entry}.cjs`),
        `module.exports = { id: "pack/${entry}", register() {} };\n`,
        "utf8",
      );
    }
    const config = {
      plugins: {
        entries: {
          "pack/one": { enabled: true },
          "pack/two": { enabled: false },
        },
      },
    };
    const env = {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const installRecords = {
      pack: {
        source: "path" as const,
        sourcePath: packageDir,
        installPath: packageDir,
      },
    };
    const index = loadInstalledPluginIndex({ config, env, installRecords, stateDir });

    expect(
      index.plugins.map((plugin) => ({
        pluginId: plugin.pluginId,
        installOwner: resolveInstalledPluginIndexInstallOwner(plugin),
        enabled: plugin.enabled,
      })),
    ).toEqual([
      { pluginId: "pack/one", installOwner: "pack", enabled: true },
      { pluginId: "pack/two", installOwner: "pack", enabled: false },
    ]);
    await writePersistedInstalledPluginIndex(index, { stateDir });
    clearPluginMetadataLifecycleCaches();
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("expected persisted package plugin index");
    }
    const persistedOwnership = createInstalledPluginOwnershipResolver(persisted);
    const firstOwnership = persistedOwnership.resolvePackage("pack/one");
    expect(firstOwnership).toMatchObject({
      ok: true,
      value: { installOwner: "pack", pluginIds: ["pack/one", "pack/two"] },
    });
    if (!firstOwnership.ok) {
      throw new Error(firstOwnership.error);
    }
    firstOwnership.value.pluginIds.reverse();
    expect(persistedOwnership.resolvePackage("pack/two")).toMatchObject({
      ok: true,
      value: { installOwner: "pack", pluginIds: ["pack/one", "pack/two"] },
    });

    const allEntries = loadPluginManifestRegistryForInstalledIndex({
      index: persisted,
      config,
      env,
      includeDisabled: true,
    });
    expect(
      allEntries.plugins.map(({ id, source }) => ({ id, source: path.basename(source) })),
    ).toEqual([
      { id: "pack/one", source: "one.cjs" },
      { id: "pack/two", source: "two.cjs" },
    ]);
    expect(allEntries.plugins.map(resolvePluginManifestInstallOwner)).toEqual(["pack", "pack"]);

    const enabledEntries = loadPluginManifestRegistryForInstalledIndex({
      index: persisted,
      config,
      env,
    });
    expect(enabledEntries.plugins.map(({ id }) => id)).toEqual(["pack/one"]);

    const ownerless = {
      ...persisted,
      plugins: persisted.plugins.map((plugin) => {
        const {
          installOwner: _installOwner,
          installOwnerAmbiguous: _installOwnerAmbiguous,
          ...ownerlessPlugin
        } = plugin as typeof plugin & {
          installOwner?: string;
          installOwnerAmbiguous?: true;
        };
        return ownerlessPlugin;
      }),
    };
    expect(createInstalledPluginOwnershipResolver(ownerless).resolvePackage("pack/one").ok).toBe(
      false,
    );

    const orphanedOwner = {
      ...persisted,
      installRecords: {
        ...persisted.installRecords,
        orphaned: {
          source: "path" as const,
          sourcePath: path.join(stateDir, "removed-orphan"),
          installPath: path.join(stateDir, "removed-orphan"),
        },
      },
    };
    const orphanOwnership = createInstalledPluginOwnershipResolver(orphanedOwner);
    expect(orphanOwnership.resolvePackage("orphaned").ok).toBe(false);
    expect(orphanOwnership.resolveLifecycle("orphaned")).toMatchObject({
      ok: true,
      value: { kind: "orphan", installOwner: "orphaned", pluginIds: [] },
    });
    expect(hasMissingInstalledPluginOwnerMetadata(orphanedOwner, env)).toBe(false);

    const legacyAmbiguous = {
      ...ownerless,
      installRecords: {
        "pack/one": installRecords.pack,
        "pack/two": installRecords.pack,
      },
    };
    const legacyOwnership = createInstalledPluginOwnershipResolver(legacyAmbiguous);
    expect(legacyOwnership.resolvePackage("pack/one").ok).toBe(false);
    expect(legacyOwnership.resolveLifecycle("pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(legacyAmbiguous, env)).toBe(true);

    const packageAlias = path.join(stateDir, "pack-alias");
    fs.symlinkSync(packageDir, packageAlias, process.platform === "win32" ? "junction" : "dir");
    const aliasedAmbiguous = {
      ...ownerless,
      installRecords: {
        "pack/one": installRecords.pack,
        "pack/two": {
          ...installRecords.pack,
          sourcePath: packageAlias,
          installPath: packageAlias,
        },
      },
    };
    const aliasedOwnership = createInstalledPluginOwnershipResolver(aliasedAmbiguous);
    expect(aliasedOwnership.resolvePackage("pack/one").ok).toBe(false);
    expect(aliasedOwnership.resolveLifecycle("pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(aliasedAmbiguous, env)).toBe(true);

    const unrelatedOwner = "unrelated";
    const relationScoped = {
      ...aliasedAmbiguous,
      plugins: [
        ...aliasedAmbiguous.plugins,
        recordInstalledPluginIndexInstallOwner(
          {
            ...aliasedAmbiguous.plugins[0]!,
            pluginId: unrelatedOwner,
            rootDir: path.join(stateDir, unrelatedOwner),
          },
          unrelatedOwner,
        ),
      ],
      installRecords: {
        ...aliasedAmbiguous.installRecords,
        [unrelatedOwner]: {
          source: "path" as const,
          sourcePath: path.join(stateDir, unrelatedOwner),
          installPath: path.join(stateDir, unrelatedOwner),
        },
      },
    };
    expect(
      createInstalledPluginOwnershipResolver(relationScoped).resolvePackage(unrelatedOwner),
    ).toMatchObject({
      ok: true,
      value: { installOwner: unrelatedOwner, pluginIds: [unrelatedOwner] },
    });

    const ambiguous = {
      ...legacyAmbiguous,
      plugins: ownerless.plugins.map((plugin) =>
        recordInstalledPluginIndexInstallOwner(plugin, undefined, true),
      ),
    };
    expect(createInstalledPluginOwnershipResolver(ambiguous).resolvePackage("pack/one").ok).toBe(
      false,
    );
    expect(hasMissingInstalledPluginOwnerMetadata(ambiguous, env)).toBe(true);
  });

  it("rechecks replaced package paths in the next ownership phase", () => {
    const rootDir = makeTempDir();
    const otherDir = makeTempDir();
    const alias = path.join(makeTempDir(), "package");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(otherDir, alias, linkType);
    const index = createIndex(rootDir);
    recordInstalledPluginIndexInstallOwner(index.plugins[0]!, "installed");
    index.installRecords = {
      installed: { source: "path", installPath: rootDir },
      orphan: { source: "path", installPath: alias },
    };
    const initial = createInstalledPluginOwnershipResolver(index);
    expect(initial.resolvePackage("installed").ok).toBe(true);
    expect(initial.resolveLifecycle("orphan")).toMatchObject({
      ok: true,
      value: { kind: "orphan", installOwner: "orphan" },
    });

    fs.unlinkSync(alias);
    fs.symlinkSync(rootDir, alias, linkType);
    const replaced = createInstalledPluginOwnershipResolver(index);
    expect(replaced.resolvePackage("installed")).toMatchObject({
      ok: false,
      error: expect.stringContaining("shares package path ownership"),
    });
    expect(replaced.resolveLifecycle("orphan").ok).toBe(false);
  });
});
