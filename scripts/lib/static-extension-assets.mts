// Discovers and copies static assets declared by bundled extension packages.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseDockerSelectedPluginBuildIdFilter } from "./bundled-plugin-build-entries.mjs";
import { isRecord } from "./record-shared.mjs";

type StaticExtensionAsset = {
  pluginDir?: string;
  src: string;
  dest: string;
};

type StaticExtensionAssetParams = {
  rootDir?: string;
  fs?: typeof fs;
  env?: NodeJS.ProcessEnv;
  includeExternalPlugins?: boolean;
  assets?: StaticExtensionAsset[];
  warn?: (message: string) => void;
};

function toPosixPath(value: unknown) {
  return (typeof value === "string" ? value : "").replaceAll("\\", "/");
}

function readJsonFile(filePath: string, fsImpl: typeof fs) {
  const value: unknown = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  return isRecord(value) ? value : {};
}

function readPackageSection(pkg: Record<string, unknown>, section: "assetScripts" | "build") {
  const openclaw = isRecord(pkg.openclaw) ? pkg.openclaw : {};
  const value = openclaw[section];
  return isRecord(value) ? value : {};
}

function normalizePackageRelativePath(value: unknown) {
  const normalized = toPosixPath(value)
    .trim()
    .replace(/^\.\/+/u, "");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return "";
  }
  return normalized;
}

function listTrackedExtensionPackageDirs(rootDir: string, fsImpl: typeof fs) {
  if (fsImpl !== fs) {
    return null;
  }
  const result = spawnSync("git", ["ls-files", "--", ":(glob)extensions/*/package.json"], {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const deletedResult = spawnSync(
    "git",
    ["ls-files", "--deleted", "--", ":(glob)extensions/*/package.json"],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (deletedResult.status !== 0) {
    return null;
  }
  const deletedPaths = new Set(
    deletedResult.stdout.split("\n").map((line) => toPosixPath(line.trim())),
  );
  return result.stdout
    .split("\n")
    .map((line) => toPosixPath(line.trim()))
    .filter((line) => line.length > 0 && !deletedPaths.has(line))
    .flatMap((line) => {
      const match = /^extensions\/([^/]+)\/package\.json$/u.exec(line);
      if (!match?.[1]) {
        return [];
      }
      const packageDir = path.join(rootDir, "extensions", match[1]);
      return [
        {
          dirName: match[1],
          hasPackageJson: true,
          packageDir,
          packageJsonPath: path.join(packageDir, "package.json"),
        },
      ];
    })
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

function listFilesystemExtensionPackageDirs(rootDir: string, fsImpl: typeof fs) {
  const extensionsRoot = path.join(rootDir, "extensions");
  if (!fsImpl.existsSync(extensionsRoot)) {
    return [];
  }
  return fsImpl
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dirName: entry.name,
      hasPackageJson: undefined,
      packageDir: path.join(extensionsRoot, entry.name),
      packageJsonPath: path.join(extensionsRoot, entry.name, "package.json"),
    }))
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

function listExtensionPackageDirs(rootDir: string, fsImpl: typeof fs) {
  return (
    listTrackedExtensionPackageDirs(rootDir, fsImpl) ??
    listFilesystemExtensionPackageDirs(rootDir, fsImpl)
  );
}

function listDistExtensionPackageDirs(rootDir: string, fsImpl: typeof fs) {
  const extensionsRoot = path.join(rootDir, "dist", "extensions");
  if (!fsImpl.existsSync(extensionsRoot)) {
    return [];
  }
  return fsImpl
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => ({
      dirName: entry.name,
      packageDir: path.join(extensionsRoot, entry.name),
    }))
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

function readPackageStaticAssetEntries(packageJson: Record<string, unknown>) {
  const entries = readPackageSection(packageJson, "build").staticAssets;
  return Array.isArray(entries) ? entries.filter(isRecord) : [];
}

function hasPackageAssetBuild(packageJson: Record<string, unknown>) {
  const command = readPackageSection(packageJson, "assetScripts").build;
  return typeof command === "string" && command.trim().length > 0;
}

function readPackageGeneratedAssetOutputEntries(packageJson: Record<string, unknown>) {
  const entries = readPackageSection(packageJson, "assetScripts").buildOutputs;
  return Array.isArray(entries) ? entries : [];
}

// External plugins (`bundledDist: false`) own their own dist and are excluded
// from core dist, so their static assets must not be discovered for core
// runtime postbuild copies.
function isExternalDistPackage(packageJson: Record<string, unknown>) {
  return readPackageSection(packageJson, "build").bundledDist === false;
}

/**
 * Discovers static asset copy specs from extension package metadata.
 *
 * External plugins (`bundledDist: false`) are skipped by default so their
 * launchers are not copied into core dist. Per-package plugin builds pass
 * `includeExternalPlugins` to still emit their own static assets.
 */
export function discoverStaticExtensionAssets(params: StaticExtensionAssetParams = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const includeExternalPlugins = params.includeExternalPlugins ?? false;
  const dockerSelectedPluginIds = parseDockerSelectedPluginBuildIdFilter(params.env ?? process.env);
  const assets: StaticExtensionAsset[] = [];
  for (const { dirName, hasPackageJson, packageJsonPath } of listExtensionPackageDirs(
    rootDir,
    fsImpl,
  )) {
    if (!(hasPackageJson ?? fsImpl.existsSync(packageJsonPath))) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath, fsImpl);
    if (
      !includeExternalPlugins &&
      isExternalDistPackage(packageJson) &&
      !dockerSelectedPluginIds?.has(dirName)
    ) {
      continue;
    }
    for (const entry of readPackageStaticAssetEntries(packageJson)) {
      const source = normalizePackageRelativePath(entry.source);
      const output = normalizePackageRelativePath(entry.output);
      if (!source || !output) {
        continue;
      }
      assets.push({
        pluginDir: dirName,
        src: toPosixPath(path.posix.join("extensions", dirName, source)),
        dest: toPosixPath(path.posix.join("dist", "extensions", dirName, output)),
      });
    }
  }
  return assets.toSorted((left, right) => left.dest.localeCompare(right.dest));
}

function discoverStaticExtensionRuntimeOverlayAssets(params: StaticExtensionAssetParams = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assetsByDest = new Map<string, StaticExtensionAsset>();
  for (const asset of params.assets ??
    discoverStaticExtensionAssets({ rootDir, fs: fsImpl, env: params.env })) {
    assetsByDest.set(asset.dest, asset);
  }
  for (const { dirName, packageDir } of listDistExtensionPackageDirs(rootDir, fsImpl)) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!fsImpl.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath, fsImpl);
    for (const entry of readPackageStaticAssetEntries(packageJson)) {
      const output = normalizePackageRelativePath(entry?.output);
      if (!output) {
        continue;
      }
      const dest = toPosixPath(path.posix.join("dist", "extensions", dirName, output));
      if (!assetsByDest.has(dest)) {
        assetsByDest.set(dest, { pluginDir: dirName, src: dest, dest });
      }
    }
  }
  return [...assetsByDest.values()].toSorted((left, right) => left.dest.localeCompare(right.dest));
}

/** Lists static asset outputs declared by extension metadata inside a packed root. */
export function listPackagedStaticExtensionAssetOutputs(
  params: Pick<StaticExtensionAssetParams, "rootDir" | "fs"> = {},
) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  return listDistExtensionPackageDirs(rootDir, fsImpl)
    .flatMap(({ dirName, packageDir }) => {
      const packageJsonPath = path.join(packageDir, "package.json");
      if (!fsImpl.existsSync(packageJsonPath)) {
        return [];
      }
      const packageJson = readJsonFile(packageJsonPath, fsImpl);
      return readPackageStaticAssetEntries(packageJson).map((entry) => {
        const output = normalizePackageRelativePath(entry.output);
        if (!output) {
          throw new Error(
            `extension ${dirName} static asset output must be a package-relative path`,
          );
        }
        return toPosixPath(path.posix.join("dist", "extensions", dirName, output));
      });
    })
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists source file paths for declared static extension assets.
 */
export function listStaticExtensionAssetSources(params: StaticExtensionAssetParams = {}) {
  const assets = params.assets ?? discoverStaticExtensionAssets(params);
  return assets
    .map(({ src }) => src.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists source-tree outputs generated by extension asset build hooks.
 */
export function listGeneratedExtensionAssetSources(params: StaticExtensionAssetParams = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const sources = new Set<string>();
  for (const { dirName, hasPackageJson, packageJsonPath } of listFilesystemExtensionPackageDirs(
    rootDir,
    fsImpl,
  )) {
    if (!(hasPackageJson ?? fsImpl.existsSync(packageJsonPath))) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath, fsImpl);
    if (!hasPackageAssetBuild(packageJson)) {
      continue;
    }

    const packageSources = [
      ...readPackageStaticAssetEntries(packageJson).map((entry) => entry.source),
      ...readPackageGeneratedAssetOutputEntries(packageJson),
    ];
    for (const entry of packageSources) {
      const source = normalizePackageRelativePath(entry);
      if (source) {
        sources.add(toPosixPath(path.posix.join("extensions", dirName, source)));
      }
    }
  }
  return [...sources].toSorted((left, right) => left.localeCompare(right));
}

/**
 * Copies declared static extension assets from source packages into root dist.
 */
export function copyStaticExtensionAssets(params: StaticExtensionAssetParams = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets =
    params.assets ?? discoverStaticExtensionAssets({ rootDir, fs: fsImpl, env: params.env });
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const srcPath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    if (fsImpl.existsSync(srcPath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(srcPath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

/**
 * Copies static assets into the dist-runtime overlay from source or root dist.
 */
export function copyStaticExtensionAssetsToRuntimeOverlay(params: StaticExtensionAssetParams = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = discoverStaticExtensionRuntimeOverlayAssets({ ...params, rootDir, fs: fsImpl });
  const runtimeExtensionsRoot = path.join(rootDir, "dist-runtime", "extensions");
  if (!fsImpl.existsSync(runtimeExtensionsRoot)) {
    return;
  }
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const normalizedDest = toPosixPath(dest);
    if (!normalizedDest.startsWith("dist/extensions/")) {
      continue;
    }
    const srcPath = path.join(rootDir, src);
    const distPath = path.join(rootDir, dest);
    const copySourcePath = fsImpl.existsSync(srcPath) ? srcPath : distPath;
    const destPath = path.join(rootDir, "dist-runtime", normalizedDest.slice("dist/".length));
    if (fsImpl.existsSync(copySourcePath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(copySourcePath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

/**
 * Copies declared static assets for one package runtime build.
 */
export function copyStaticExtensionAssetsForPackage(
  params: StaticExtensionAssetParams & { pluginDir: string },
) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets =
    params.assets ??
    discoverStaticExtensionAssets({
      rootDir,
      fs: fsImpl,
      env: params.env,
      includeExternalPlugins: true,
    });
  const packagePrefix = `extensions/${params.pluginDir}/`;
  const rootDistPrefix = `dist/extensions/${params.pluginDir}/`;
  const copied: string[] = [];
  for (const { src, dest } of assets) {
    const normalizedSrc = src.replaceAll("\\", "/");
    const normalizedDest = dest.replaceAll("\\", "/");
    if (!normalizedSrc.startsWith(packagePrefix) || !normalizedDest.startsWith(rootDistPrefix)) {
      continue;
    }
    const srcPath = path.join(rootDir, src);
    if (!fsImpl.existsSync(srcPath)) {
      continue;
    }
    const packageRelativeDest = normalizedDest.slice(rootDistPrefix.length);
    const destPath = path.join(rootDir, packagePrefix, "dist", packageRelativeDest);
    fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
    fsImpl.copyFileSync(srcPath, destPath);
    copied.push(`dist/${packageRelativeDest}`);
  }
  return copied.toSorted((left, right) => left.localeCompare(right));
}
