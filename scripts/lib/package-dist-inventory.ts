import fs from "node:fs/promises";
import path from "node:path";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { writeJson } from "../../src/infra/json-files.ts";
import {
  collectPackageDistInventory,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
} from "../../src/infra/package-dist-inventory.ts";

export { LOCAL_BUILD_METADATA_DIST_PATHS } from "./local-build-metadata-paths.mjs";
export { PACKAGE_DIST_INVENTORY_RELATIVE_PATH };

const INSTALL_STAGE_DEBRIS_DIR_PATTERN = /^\.openclaw-install-stage(?:-[^/]+)?$/iu;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isInstallStageDirName(value: string): boolean {
  return INSTALL_STAGE_DEBRIS_DIR_PATTERN.test(value);
}

export function isLegacyPluginDependencyInstallStagePath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/");
  return (
    parts.length >= 4 &&
    parts[0]?.toLowerCase() === "dist" &&
    parts[1]?.toLowerCase() === "extensions" &&
    Boolean(parts[2]) &&
    isInstallStageDirName(parts[3] ?? "")
  );
}

async function collectLegacyPluginDependencyStagingDebrisPaths(
  packageRoot: string,
): Promise<string[]> {
  const distDirs: string[] = [];
  try {
    const packageRootEntries = await fs.readdir(packageRoot, { withFileTypes: true });
    for (const entry of packageRootEntries) {
      if (entry.isDirectory() && entry.name.toLowerCase() === "dist") {
        distDirs.push(path.join(packageRoot, entry.name));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const debris: string[] = [];
  for (const distDir of distDirs) {
    let distEntries: import("node:fs").Dirent[];
    try {
      distEntries = await fs.readdir(distDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const distEntry of distEntries) {
      if (!distEntry.isDirectory() || distEntry.name.toLowerCase() !== "extensions") {
        continue;
      }
      const extensionsDir = path.join(distDir, distEntry.name);
      let extensionEntries: import("node:fs").Dirent[];
      try {
        extensionEntries = await fs.readdir(extensionsDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      for (const extensionEntry of extensionEntries) {
        if (!extensionEntry.isDirectory()) {
          continue;
        }
        const extensionPath = path.join(extensionsDir, extensionEntry.name);
        let stagingEntries: import("node:fs").Dirent[];
        try {
          stagingEntries = await fs.readdir(extensionPath, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw error;
        }
        for (const stagingEntry of stagingEntries) {
          if (!isInstallStageDirName(stagingEntry.name)) {
            continue;
          }
          debris.push(
            normalizeRelativePath(
              path.relative(packageRoot, path.join(extensionPath, stagingEntry.name)),
            ),
          );
        }
      }
    }
  }
  return debris.toSorted((left, right) => left.localeCompare(right));
}

async function assertNoLegacyPluginDependencyStagingDebris(packageRoot: string): Promise<void> {
  const debris = await collectLegacyPluginDependencyStagingDebrisPaths(packageRoot);
  if (debris.length === 0) {
    return;
  }
  throw new Error(
    `unexpected legacy plugin dependency staging debris in package dist: ${debris.join(", ")}`,
  );
}

export async function writePackageDistInventory(packageRoot: string): Promise<string[]> {
  await assertNoLegacyPluginDependencyStagingDebris(packageRoot);
  const inventory = sortUniqueStrings(await collectPackageDistInventory(packageRoot));
  const inventoryPath = path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  await writeJson(inventoryPath, inventory, { trailingNewline: true });
  return inventory;
}
