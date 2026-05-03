import fs from "node:fs/promises";
import path from "node:path";
import { isLocalBuildMetadataDistPath } from "../../scripts/lib/local-build-metadata-paths.mjs";

export { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";

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
  /^dist\/extensions\/qa-matrix(?:\/|$)/u,
  new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_CHANNEL_DIR}(?:/|$)`, "u"),
  new RegExp(`^dist/plugin-sdk/extensions/${LEGACY_QA_LAB_DIR}(?:/|$)`, "u"),
] as const;
const INSTALL_STAGE_DEBRIS_DIR_PATTERN = /^\.openclaw-install-stage(?:-[^/]+)?$/iu;
type ExternalizedBundledExtensionIds = ReadonlySet<string>;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isInstallStageDirName(value: string): boolean {
  return INSTALL_STAGE_DEBRIS_DIR_PATTERN.test(value);
}

function isLegacyPluginDependencyDirPath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/");
  if (parts[0]?.toLowerCase() !== "dist" || parts[1]?.toLowerCase() !== "extensions") {
    return false;
  }

  const rootDependencyDir = parts[2] ?? "";
  if (rootDependencyDir.toLowerCase() === "node_modules") {
    return true;
  }

  const pluginDependencyDir = parts[3] ?? "";
  return pluginDependencyDir.toLowerCase() === "node_modules";
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

function collectExcludedPackagedExtensionDirs(rootPackageJson: unknown): Set<string> {
  if (!rootPackageJson || typeof rootPackageJson !== "object") {
    return new Set();
  }
  const files = (rootPackageJson as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return new Set();
  }
  const excluded = new Set<string>();
  for (const entry of files) {
    if (typeof entry !== "string") {
      continue;
    }
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
    if (match?.[1]) {
      excluded.add(match[1]);
    }
  }
  return excluded;
}

function isExternalizedBundledExtensionDistPath(
  relativePath: string,
  externalizedExtensionIds: ExternalizedBundledExtensionIds,
): boolean {
  if (externalizedExtensionIds.size === 0) {
    return false;
  }
  const parts = normalizeRelativePath(relativePath).split("/");
  return (
    parts.length >= 3 &&
    parts[0] === "dist" &&
    parts[1] === "extensions" &&
    Boolean(parts[2]) &&
    externalizedExtensionIds.has(parts[2] ?? "")
  );
}

async function collectExternalizedBundledExtensionIds(
  packageRoot: string,
): Promise<ExternalizedBundledExtensionIds> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as unknown;
    return collectExcludedPackagedExtensionDirs(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
}

function isPackagedDistPath(
  relativePath: string,
  externalizedExtensionIds: ExternalizedBundledExtensionIds,
): boolean {
  if (!relativePath.startsWith("dist/")) {
    return false;
  }
  if (isExternalizedBundledExtensionDistPath(relativePath, externalizedExtensionIds)) {
    return false;
  }
  if (isLegacyPluginDependencyDirPath(relativePath)) {
    return false;
  }
  if (relativePath === PACKAGE_DIST_INVENTORY_RELATIVE_PATH) {
    return false;
  }
  if (isLocalBuildMetadataDistPath(relativePath)) {
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

function isOmittedDistSubtree(
  relativePath: string,
  externalizedExtensionIds: ExternalizedBundledExtensionIds,
): boolean {
  return (
    isExternalizedBundledExtensionDistPath(relativePath, externalizedExtensionIds) ||
    isLegacyPluginDependencyDirPath(relativePath) ||
    OMITTED_DIST_SUBTREE_PATTERNS.some((pattern) => pattern.test(relativePath))
  );
}

async function collectRelativeFiles(
  rootDir: string,
  baseDir: string,
  externalizedExtensionIds: ExternalizedBundledExtensionIds,
): Promise<string[]> {
  const rootRelativePath = normalizeRelativePath(path.relative(baseDir, rootDir));
  if (rootRelativePath && isOmittedDistSubtree(rootRelativePath, externalizedExtensionIds)) {
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
          return await collectRelativeFiles(entryPath, baseDir, externalizedExtensionIds);
        }
        if (entry.isFile()) {
          return isPackagedDistPath(relativePath, externalizedExtensionIds) ? [relativePath] : [];
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
  const externalizedExtensionIds = await collectExternalizedBundledExtensionIds(packageRoot);
  return await collectRelativeFiles(
    path.join(packageRoot, "dist"),
    packageRoot,
    externalizedExtensionIds,
  );
}

export async function collectLegacyPluginDependencyStagingDebrisPaths(
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

export async function assertNoLegacyPluginDependencyStagingDebris(
  packageRoot: string,
): Promise<void> {
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
  const inventory = [...new Set(await collectPackageDistInventory(packageRoot))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const inventoryPath = path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH);
  await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
  await fs.writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

async function readPackageDistInventory(packageRoot: string): Promise<string[]> {
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
