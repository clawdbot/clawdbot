import fs from "node:fs/promises";
import path from "node:path";

export const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
const LEGACY_QA_CHANNEL_DIR = ["qa", "channel"].join("-");
const LEGACY_QA_LAB_DIR = ["qa", "lab"].join("-");
const OMITTED_QA_EXTENSION_PREFIXES = [
  `dist/extensions/${LEGACY_QA_CHANNEL_DIR}/`,
  `dist/extensions/${LEGACY_QA_LAB_DIR}/`,
  "dist/extensions/qa-matrix/",
];
const OMITTED_PRIVATE_QA_PLUGIN_SDK_PREFIXES = [
  `dist/plugin-sdk/extensions/${LEGACY_QA_CHANNEL_DIR}/`,
  `dist/plugin-sdk/extensions/${LEGACY_QA_LAB_DIR}/`,
];
const OMITTED_PRIVATE_QA_PLUGIN_SDK_FILES = new Set([
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.d.ts`,
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.js`,
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.d.ts`,
  `dist/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.js`,
  `dist/plugin-sdk/${LEGACY_QA_LAB_DIR}.d.ts`,
  `dist/plugin-sdk/${LEGACY_QA_LAB_DIR}.js`,
  "dist/plugin-sdk/qa-runtime.d.ts",
  "dist/plugin-sdk/qa-runtime.js",
  `dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}.d.ts`,
  `dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_CHANNEL_DIR}-protocol.d.ts`,
  `dist/plugin-sdk/src/plugin-sdk/${LEGACY_QA_LAB_DIR}.d.ts`,
  "dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts",
]);
const OMITTED_PRIVATE_QA_DIST_PREFIXES = ["dist/qa-runtime-"];
const OMITTED_DIST_SUBTREE_PATTERNS = [
  /^dist\/extensions\/node_modules(?:\/|$)/u,
  /^dist\/extensions\/[^/]+\/node_modules(?:\/|$)/u,
  /^dist\/extensions\/[^/]+\/\.openclaw-runtime-deps-[^/]+(?:\/|$)/u,
  /^dist\/extensions\/qa-matrix(?:\/|$)/u,
  new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_CHANNEL_DIR}(?:/|$)`, "u"),
  new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_LAB_DIR}(?:/|$)`, "u"),
] as const;
const INSTALL_STAGE_DEBRIS_DIR_PATTERN = /^\.openclaw-install-stage(?:-[^/]+)?$/iu;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isInstallStageDirName(value: string): boolean {
  return INSTALL_STAGE_DEBRIS_DIR_PATTERN.test(value);
}

export function isBundledRuntimeDepsInstallStagePath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/");
  return (
    parts.length >= 4 &&
    parts[0]?.toLowerCase() === "dist" &&
    parts[1]?.toLowerCase() === "extensions" &&
    Boolean(parts[2]) &&
    isInstallStageDirName(parts[3] ?? "")
  );
}

function isPackagedDistPath(relativePath: string): boolean {
  if (!relativePath.startsWith("dist/")) {
    return false;
  }
  if (relativePath === PACKAGE_DIST_INVENTORY_RELATIVE_PATH) {
    return false;
  }
  if (relativePath.endsWith("/.openclaw-runtime-deps-stamp.json")) {
    return false;
  }
  if (relativePath.endsWith(".map")) {
    return false;
  }
  if (relativePath === "dist/plugin-sdk/.tsbuildinfo") {
    return false;
  }
  if (
    OMITTED_PRIVATE_QA_PLUGIN_SDK_PREFIXES.some((prefix) => relativePath.startsWith(prefix)) ||
    OMITTED_PRIVATE_QA_PLUGIN_SDK_FILES.has(relativePath) ||
    OMITTED_PRIVATE_QA_DIST_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  ) {
    return false;
  }
  if (OMITTED_QA_EXTENSION_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }
  return true;
}

function isOmittedDistSubtree(relativePath: string): boolean {
  return (
    isBundledRuntimeDepsInstallStagePath(relativePath) ||
    OMITTED_DIST_SUBTREE_PATTERNS.some((pattern) => pattern.test(relativePath))
  );
}

async function collectRelativeFiles(rootDir: string, baseDir: string): Promise<string[]> {
  const rootRelativePath = normalizeRelativePath(path.relative(baseDir, rootDir));
  if (rootRelativePath && isOmittedDistSubtree(rootRelativePath)) {
    return [];
  }
  try {
    const rootStats = await fs.lstat(rootDir);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error(
        `Unsafe package dist path: ${normalizeRelativePath(path.relative(baseDir, rootDir))}`,
      );
    }
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(rootDir, entry.name);
        const relativePath = normalizeRelativePath(path.relative(baseDir, entryPath));
        if (entry.isSymbolicLink()) {
          throw new Error(`Unsafe package dist path: ${relativePath}`);
        }
        if (entry.isDirectory()) {
          return await collectRelativeFiles(entryPath, baseDir);
        }
        if (entry.isFile()) {
          return isPackagedDistPath(relativePath) ? [relativePath] : [];
        }
        return [];
      }),
    );
    return files.flat().toSorted((left, right) => left.localeCompare(right));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function collectPackageDistInventory(packageRoot: string): Promise<string[]> {
  return await collectRelativeFiles(path.join(packageRoot, "dist"), packageRoot);
}

export async function collectBundledRuntimeDepsStagingDebrisPaths(
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

export async function assertNoBundledRuntimeDepsStagingDebris(packageRoot: string): Promise<void> {
  const debris = await collectBundledRuntimeDepsStagingDebrisPaths(packageRoot);
  if (debris.length === 0) {
    return;
  }
  throw new Error(
    `unexpected bundled-runtime-deps install staging debris in package dist: ${debris.join(", ")}`,
  );
}

export async function writePackageDistInventory(packageRoot: string): Promise<string[]> {
  await assertNoBundledRuntimeDepsStagingDebris(packageRoot);
  const inventory = [...new Set(await collectPackageDistInventory(packageRoot))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const inventoryPath = path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
  await fs.writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

export async function readPackageDistInventory(packageRoot: string): Promise<string[]> {
  const inventoryPath = path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  const raw = await fs.readFile(inventoryPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid package dist inventory at ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`);
  }
  return [...new Set(parsed.map(normalizeRelativePath))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export async function readPackageDistInventoryIfPresent(
  packageRoot: string,
): Promise<string[] | null> {
  try {
    return await readPackageDistInventory(packageRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function collectPackageDistInventoryErrors(packageRoot: string): Promise<string[]> {
  const expectedFiles = await readPackageDistInventoryIfPresent(packageRoot);
  if (expectedFiles === null) {
    return [`missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`];
  }

  const actualFiles = await collectPackageDistInventory(packageRoot);
  const expectedSet = new Set(expectedFiles);
  const actualSet = new Set(actualFiles);
  const errors: string[] = [];

  for (const relativePath of expectedFiles) {
    if (!actualSet.has(relativePath)) {
      errors.push(`missing packaged dist file ${relativePath}`);
    }
  }
  for (const relativePath of actualFiles) {
    if (!expectedSet.has(relativePath)) {
      errors.push(`unexpected packaged dist file ${relativePath}`);
    }
  }
  return errors;
}
