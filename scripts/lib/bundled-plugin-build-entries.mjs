import { spawnSync } from "node:child_process";
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
const EXCLUDED_CORE_BUNDLED_PLUGIN_DIRS = new Set(["qqbot", "whatsapp"]);
const toPosixPath = (value) => value.replaceAll("\\", "/");

function readBundledPluginPackageJson(packageJsonPath, options = {}) {
  if (!(options.hasPackageJson ?? fs.existsSync(packageJsonPath))) {
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

function shouldBuildBundledDistEntry(packageJson) {
  return packageJson?.openclaw?.build?.bundledDist !== false;
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

function collectTopLevelPublicSurfaceEntriesFromFiles(relativeFiles) {
  return relativeFiles
    .flatMap((relativeFile) => {
      if (relativeFile.includes("/")) {
        return [];
      }

      const ext = path.extname(relativeFile);
      if (!TOP_LEVEL_PUBLIC_SURFACE_EXTENSIONS.has(ext)) {
        return [];
      }

      const normalizedName = relativeFile.toLowerCase();
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

      return [`./${relativeFile}`];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function collectTrackedBundledPluginFiles(cwd) {
  const result = spawnSync("git", ["ls-files", "--", BUNDLED_PLUGIN_ROOT_DIR], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }

  const filesByPlugin = new Map();
  for (const rawLine of result.stdout.split("\n")) {
    const line = toPosixPath(rawLine.trim());
    const match = new RegExp(`^${BUNDLED_PLUGIN_ROOT_DIR}/([^/]+)/(.+)$`).exec(line);
    if (!match) {
      continue;
    }
    const [, dirName, relativeFile] = match;
    const files = filesByPlugin.get(dirName) ?? [];
    files.push(relativeFile);
    filesByPlugin.set(dirName, files);
  }

  return filesByPlugin;
}

function collectBundledPluginCandidates(cwd, extensionsRoot) {
  const trackedFiles = collectTrackedBundledPluginFiles(cwd);
  if (trackedFiles) {
    return [...trackedFiles.entries()]
      .map(([dirName, relativeFiles]) => ({
        dirName,
        pluginDir: path.join(extensionsRoot, dirName),
        relativeFiles,
        topLevelPublicSurfaceEntries: collectTopLevelPublicSurfaceEntriesFromFiles(relativeFiles),
      }))
      .toSorted((left, right) => left.dirName.localeCompare(right.dirName));
  }

  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const pluginDir = path.join(extensionsRoot, dirent.name);
      return {
        dirName: dirent.name,
        pluginDir,
        relativeFiles: null,
        topLevelPublicSurfaceEntries: collectTopLevelPublicSurfaceEntries(pluginDir),
      };
    });
}

export function collectBundledPluginBuildEntries(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const extensionsRoot = path.join(cwd, BUNDLED_PLUGIN_ROOT_DIR);
  const entries = [];

  for (const candidate of collectBundledPluginCandidates(cwd, extensionsRoot)) {
    const { dirName, pluginDir, relativeFiles, topLevelPublicSurfaceEntries } = candidate;
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const hasManifest = relativeFiles?.includes("openclaw.plugin.json") ?? fs.existsSync(manifestPath);
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageJson = readBundledPluginPackageJson(packageJsonPath, {
      hasPackageJson: relativeFiles?.includes("package.json"),
    });
    if (
      !hasManifest &&
      !isManifestlessBundledRuntimeSupportPackage({
        dirName,
        packageJson,
        topLevelPublicSurfaceEntries,
      })
    ) {
      continue;
    }
    if (!shouldBuildBundledCluster(dirName, env, { packageJson })) {
      continue;
    }
    if (!shouldBuildBundledDistEntry(packageJson)) {
      continue;
    }
    if (EXCLUDED_CORE_BUNDLED_PLUGIN_DIRS.has(dirName)) {
      continue;
    }

    entries.push({
      id: dirName,
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
