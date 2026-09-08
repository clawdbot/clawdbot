// Composes explicitly selected source plugins into a custom core distribution.
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  composePackagePlugins,
  type DistributionPackageManifest,
} from "../../src/infra/package-plugin-composition.ts";
import {
  collectBundledPluginBuildEntries,
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./output-root-guard.mjs";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory-contract.mts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "./package-lifecycle-marker.mjs";

type PackageJson = DistributionPackageManifest;

export function resolvePackageBundledPlugins(sourceDir: string, pluginIds: string[]) {
  const ids = [...new Set(pluginIds)].toSorted();
  if (ids.length === 0) {
    return [];
  }
  const entries = collectBundledPluginBuildEntries({
    cwd: sourceDir,
    env: { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: ids.join(",") },
  });
  const excluded = collectRootPackageExcludedExtensionDirs({ cwd: sourceDir });
  return ids.map((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry?.hasPackageJson || !excluded.has(id) || NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(id)) {
      throw new Error(
        `--bundle-plugin requires a source plugin excluded from the core package: ${id}`,
      );
    }
    return entry;
  });
}

/** Called under the canonical packer's source lifecycle lock, before bundling workspace deps. */
export async function preparePackageBundledPlugins(sourceDir: string, pluginIds: string[]) {
  const selected = resolvePackageBundledPlugins(sourceDir, pluginIds);
  if (selected.length === 0) {
    return async () => {};
  }
  assertRealOutputRoot(path.join(sourceDir, "dist"));
  const packagePath = path.join(sourceDir, "package.json");
  const original = await fs.readFile(packagePath, "utf8");
  const sourcePackageJson = JSON.parse(original) as PackageJson;
  for (const { id, sourceEntries } of selected) {
    const sourcePackage = JSON.parse(
      await fs.readFile(path.join(sourceDir, "extensions", id, "package.json"), "utf8"),
    ) as PackageJson;
    const pluginRoot = path.join(sourceDir, "dist", "extensions", id);
    const builtPackage = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"),
    ) as PackageJson;
    const manifest = JSON.parse(
      await fs.readFile(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    ) as { id: string };
    if (
      manifest.id !== id ||
      (
        [
          "name",
          "version",
          "dependencies",
          "optionalDependencies",
          "peerDependencies",
          "peerDependenciesMeta",
        ] as const
      ).some((key) => !isDeepStrictEqual(builtPackage[key], sourcePackage[key]))
    ) {
      throw new Error(
        `Built plugin ${id} does not match source metadata; rebuild before packaging`,
      );
    }
    for (const entry of sourceEntries) {
      await fs.access(path.join(pluginRoot, entry.replace(/\.[^.]+$/u, ".js")));
    }
  }
  const packageJson = composePackagePlugins(
    sourcePackageJson,
    selected.map(({ id, packageJson: pluginPackage }) => ({
      id,
      packageJson: pluginPackage as PackageJson,
    })),
  );
  const snapshots = await Promise.all(
    [
      "package.json",
      PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
      PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
    ].map(async (relativePath) => {
      const target = path.join(sourceDir, relativePath);
      const bytes = await fs.readFile(target).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
        return null;
      });
      return { target, bytes };
    }),
  );
  const cleanup = async (preparationFailure?: { cause: unknown }) => {
    const results = await Promise.allSettled(
      snapshots.map(({ target, bytes }) =>
        bytes === null ? fs.rm(target, { force: true }) : fs.writeFile(target, bytes),
      ),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(
        [
          ...(preparationFailure ? [preparationFailure.cause] : []),
          ...failures.map((result) => result.reason),
        ],
        "Selected plugin package cleanup failed",
        preparationFailure,
      );
    }
  };
  try {
    await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    // Inventory must see the custom manifest before pack, or postinstall would prune the plugin.
    const { writePackageDistInventoryForPublish } = await import("./package-dist-inventory.ts");
    await writePackageDistInventoryForPublish(sourceDir);
    return cleanup;
  } catch (error) {
    await cleanup({ cause: error });
    throw error;
  }
}
