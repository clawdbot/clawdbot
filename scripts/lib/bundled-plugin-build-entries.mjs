import fs from "node:fs";
import path from "node:path";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  bundledDistPluginFile,
  bundledPluginFile,
} from "./bundled-plugin-paths.mjs";
import { shouldBuildBundledCluster } from "./optional-bundled-clusters.mjs";

const TOP_LEVEL_PUBLIC_SURFACE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);
export const NON_PACKAGED_BUNDLED_PLUGIN_DIRS = new Set(["qa-channel", "qa-lab", "qa-matrix"]);
const EXCLUDED_CORE_BUNDLED_PLUGIN_DIRS = new Set(["qqbot"]);
const toPosixPath = (value) => value.replaceAll("\\", "/");

function readBundledPluginPackageJson(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch {
    return null;
  }
}

function isManifestlessBundledRuntimeSupportPackage(params) {
  const packageName = typeof params.packageJson?.name === "string" ? params.packageJson.name : "";
  if (packageName !== `@openclaw/${params.dirName}`) {
    return false;
  }
  return params.topLevelPublicSurfaceEntries.length > 0;
}

export function collectPluginSourceEntries(packageJson) {
  let packageEntries = Array.isArray(packageJson?.openclaw?.extensions)
    ? packageJson.openclaw.extensions.filter(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const setupEntry =
    typeof packageJson?.openclaw?.setupEntry === "string" &&
    packageJson.openclaw.setupEntry.trim().length > 0
      ? packageJson.openclaw.setupEntry
      : undefined;
  if (setupEntry) {
    packageEntries = Array.from(new Set([...packageEntries, setupEntry]));
  }
  return packageEntries.length > 0 ? packageEntries : ["./index.ts"];
}

export function collectTopLevelPublicSurfaceEntries(pluginDir) {
  if (!fs.existsSync(pluginDir)) {
    return [];
  }

  return fs
    .readdirSync(pluginDir, { withFileTypes: true })
    .flatMap((dirent) => {
      if (!dirent.isFile()) {
        return [];
      }

      const ext = path.extname(dirent.name);
      if (!TOP_LEVEL_PUBLIC_SURFACE_EXTENSIONS.has(ext)) {
        return [];
      }

      const normalizedName = dirent.name.toLowerCase();
      if (
        normalizedName.endsWith(".d.ts") ||
        /^config-api\.(?:[cm]?[jt]s)$/u.test(normalizedName) ||
        normalizedName.includes(".test.") ||
        normalizedName.includes(".spec.") ||
        normalizedName.includes(".fixture.") ||
        normalizedName.includes(".snap")
      ) {
        return [];
      }

      return [`./${dirent.name}`];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

export function collectBundledPluginBuildEntries(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const extensionsRoot = path.join(cwd, BUNDLED_PLUGIN_ROOT_DIR);
  const entries = [];

  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const hasManifest = fs.existsSync(manifestPath);
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageJson = readBundledPluginPackageJson(packageJsonPath);
    const topLevelPublicSurfaceEntries = collectTopLevelPublicSurfaceEntries(pluginDir);
    if (
      !hasManifest &&
      !isManifestlessBundledRuntimeSupportPackage({
        dirName: dirent.name,
        packageJson,
        topLevelPublicSurfaceEntries,
      })
    ) {
      continue;
    }
    if (!shouldBuildBundledCluster(dirent.name, env, { packageJson })) {
      continue;
    }
    if (EXCLUDED_CORE_BUNDLED_PLUGIN_DIRS.has(dirent.name)) {
      continue;
    }

    entries.push({
      id: dirent.name,
      hasManifest,
      hasPackageJson: packageJson !== null,
      packageJson,
      sourceEntries: Array.from(
        new Set([
          ...(hasManifest ? collectPluginSourceEntries(packageJson) : []),
          ...topLevelPublicSurfaceEntries,
        ]),
      ),
    });
  }

  return entries;
}

export function listBundledPluginBuildEntries(params = {}) {
  return Object.fromEntries(
    collectBundledPluginBuildEntries(params).flatMap(({ id, sourceEntries }) =>
      sourceEntries.map((entry) => {
        const normalizedEntry = entry.replace(/^\.\//, "");
        const entryKey = bundledPluginFile(id, normalizedEntry.replace(/\.[^.]+$/u, ""));
        return [entryKey, toPosixPath(path.join(BUNDLED_PLUGIN_ROOT_DIR, id, normalizedEntry))];
      }),
    ),
  );
}

export function collectRootPackageExcludedExtensionDirs(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const packageJsonPath = path.join(cwd, "package.json");
  const excluded = new Set();
  if (!fs.existsSync(packageJsonPath)) {
    return excluded;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  for (const entry of packageJson.files ?? []) {
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

export function listBundledPluginPackArtifacts(params = {}) {
  const excludedPackageDirs =
    params.includeRootPackageExcludedDirs === true
      ? new Set()
      : collectRootPackageExcludedExtensionDirs(params);
  const entries = collectBundledPluginBuildEntries(params).filter(
    ({ id }) => !NON_PACKAGED_BUNDLED_PLUGIN_DIRS.has(id) && !excludedPackageDirs.has(id),
  );
  const artifacts = new Set();

  for (const { id, hasManifest, hasPackageJson, sourceEntries } of entries) {
    if (hasManifest) {
      artifacts.add(bundledDistPluginFile(id, "openclaw.plugin.json"));
    }
    if (hasPackageJson) {
      artifacts.add(bundledDistPluginFile(id, "package.json"));
    }
    for (const entry of sourceEntries) {
      const normalizedEntry = entry.replace(/^\.\//, "").replace(/\.[^.]+$/u, "");
      artifacts.add(bundledDistPluginFile(id, `${normalizedEntry}.js`));
    }
  }

  return [...artifacts].toSorted((left, right) => left.localeCompare(right));
}
