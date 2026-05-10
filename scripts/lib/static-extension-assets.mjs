import fs from "node:fs";
import path from "node:path";

function toPosixPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function readJsonFile(filePath, fsImpl) {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function normalizePackageRelativePath(value) {
  const normalized = toPosixPath(value)
    .trim()
    .replace(/^\.\/+/u, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
    return "";
  }
  return normalized;
}

function listExtensionPackageDirs(rootDir, fsImpl) {
  const extensionsRoot = path.join(rootDir, "extensions");
  if (!fsImpl.existsSync(extensionsRoot)) {
    return [];
  }
  return fsImpl
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dirName: entry.name,
      packageDir: path.join(extensionsRoot, entry.name),
    }))
    .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
}

function listDistExtensionPackageDirs(rootDir, fsImpl) {
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

function readPackageStaticAssetEntries(packageJson) {
  const entries = packageJson.openclaw?.build?.staticAssets;
  return Array.isArray(entries) ? entries : [];
}

export function discoverStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = [];
  for (const { dirName, packageDir } of listExtensionPackageDirs(rootDir, fsImpl)) {
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!fsImpl.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = readJsonFile(packageJsonPath, fsImpl);
    for (const entry of readPackageStaticAssetEntries(packageJson)) {
      const source = normalizePackageRelativePath(entry?.source);
      const output = normalizePackageRelativePath(entry?.output);
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

function discoverStaticExtensionRuntimeOverlayAssets(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assetsByDest = new Map();
  for (const asset of params.assets ?? discoverStaticExtensionAssets({ rootDir, fs: fsImpl })) {
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

export function listStaticExtensionAssetOutputs(params = {}) {
  const assets = params.assets ?? discoverStaticExtensionAssets(params);
  return assets
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

export function listStaticExtensionAssetSources(params = {}) {
  const assets = params.assets ?? discoverStaticExtensionAssets(params);
  return assets
    .map(({ src }) => src.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

export function copyStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = params.assets ?? discoverStaticExtensionAssets({ rootDir, fs: fsImpl });
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

export function copyStaticExtensionAssetsToRuntimeOverlay(params = {}) {
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

export function copyStaticExtensionAssetsForPackage(params) {
  const rootDir = params.rootDir ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const assets = params.assets ?? discoverStaticExtensionAssets({ rootDir, fs: fsImpl });
  const packagePrefix = `extensions/${params.pluginDir}/`;
  const rootDistPrefix = `dist/extensions/${params.pluginDir}/`;
  const copied = [];
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
