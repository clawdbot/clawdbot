// Composes explicitly selected source plugins into a custom core distribution.
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { satisfies, valid } from "semver";
import { validateBundledPackageDependencyAlignment } from "../package-source-dependencies.mjs";
import {
  collectBundledPluginBuildEntries,
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
  NON_PACKAGED_BUNDLED_PLUGIN_DIRS,
} from "./bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./output-root-guard.mjs";
import {
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
} from "./package-dist-inventory-contract.mts";

type PackageJson = {
  name: string;
  version: string;
  files: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

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
  const packageJson = JSON.parse(original) as PackageJson;
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
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      const dependencies = sourcePackage[section] ?? {};
      for (const [name, spec] of Object.entries(dependencies)) {
        if (valid(spec) !== spec) {
          throw new Error(
            `Selected plugin ${id} requires an exact dependency pin: ${name}@${spec}`,
          );
        }
      }
      for (const existing of [packageJson.dependencies, packageJson.optionalDependencies]) {
        validateBundledPackageDependencyAlignment({
          bundledDependencies: dependencies,
          bundledPackageLabel: `selected plugin ${id}`,
          rootDependencies: { ...dependencies, ...existing },
        });
      }
      packageJson[section] = { ...packageJson[section], ...dependencies };
    }
  }
  // A required dependency must not remain optional when another selected owner needs it.
  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    delete packageJson.optionalDependencies?.[name];
  }
  for (const { id, packageJson: metadata } of selected) {
    const plugin = metadata as PackageJson;
    for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
      const version =
        name === packageJson.name
          ? packageJson.version
          : (packageJson.dependencies?.[name] ?? packageJson.optionalDependencies?.[name]);
      if (
        (!version && !plugin.peerDependenciesMeta?.[name]?.optional) ||
        (version && !satisfies(version, range))
      ) {
        throw new Error(`Selected plugin ${id} requires peer ${name}@${range} in the distribution`);
      }
    }
  }
  const exclusions = new Set(selected.map(({ id }) => `!dist/extensions/${id}/**`));
  packageJson.files = packageJson.files.filter((entry) => !exclusions.has(entry));
  const snapshots = await Promise.all(
    ["package.json", PACKAGE_DIST_INVENTORY_RELATIVE_PATH, PACKAGE_INSTALL_GUARD_RELATIVE_PATH].map(
      async (relativePath) => {
        const target = path.join(sourceDir, relativePath);
        const bytes = await fs.readFile(target).catch((error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
          return null;
        });
        return { target, bytes };
      },
    ),
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
