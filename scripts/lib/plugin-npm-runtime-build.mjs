import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import {
  collectPluginSourceEntries,
  collectTopLevelPublicSurfaceEntries,
} from "./bundled-plugin-build-entries.mjs";
import { copyStaticExtensionAssetsForPackage } from "./static-extension-assets.mjs";

const env = {
  NODE_ENV: "production",
};

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function isPublishablePluginPackage(packageJson) {
  return packageJson.openclaw?.release?.publishToNpm === true;
}

function normalizePackageEntry(value) {
  return typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
}

function isTypeScriptEntry(entry) {
  return /\.(?:c|m)?ts$/u.test(entry);
}

function toPackageRuntimeEntry(entry) {
  const normalized = normalizePackageEntry(entry).replace(/^\.\//u, "");
  return `./dist/${normalized.replace(/\.[^.]+$/u, ".js")}`;
}

function collectExternalDependencyNames(packageJson) {
  return new Set(
    [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ].filter(Boolean),
  );
}

function getStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entryValue]) => typeof entryValue === "string" && entryValue.trim().length > 0,
    ),
  );
}

function getRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function createNeverBundleDependencyMatcher(packageJson) {
  const externalDependencies = collectExternalDependencyNames(packageJson);
  return (id) => {
    if (id === "openclaw" || id.startsWith("openclaw/")) {
      return true;
    }
    for (const dependency of externalDependencies) {
      if (id === dependency || id.startsWith(`${dependency}/`)) {
        return true;
      }
    }
    return false;
  };
}

function packageEntryKey(entry) {
  return normalizePackageEntry(entry)
    .replace(/^\.\//u, "")
    .replace(/\.[^.]+$/u, "");
}

function resolvePackageDir(repoRoot, packageDir) {
  return path.isAbsolute(packageDir) ? packageDir : path.resolve(repoRoot, packageDir);
}

function packageRelativePathExists(packageDir, relativePath) {
  return fs.existsSync(path.join(packageDir, relativePath));
}

export function listPublishablePluginPackageDirs(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const extensionsRoot = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("extensions", entry.name))
    .filter((packageDir) => {
      const packageJsonPath = path.join(repoRoot, packageDir, "package.json");
      return (
        fs.existsSync(packageJsonPath) && isPublishablePluginPackage(readJsonFile(packageJsonPath))
      );
    })
    .toSorted((left, right) => left.localeCompare(right));
}

export function listPluginNpmRuntimeBuildOutputs(plan) {
  return Object.keys(plan.entry)
    .map((entryKey) => `./dist/${entryKey}.js`)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolvePluginNpmRuntimePackageFiles(plan) {
  const merged = new Set(
    Array.isArray(plan.packageJson.files)
      ? plan.packageJson.files.filter((entry) => typeof entry === "string")
      : [],
  );
  merged.add("dist/**");
  if (packageRelativePathExists(plan.packageDir, "openclaw.plugin.json")) {
    merged.add("openclaw.plugin.json");
  }
  if (packageRelativePathExists(plan.packageDir, "README.md")) {
    merged.add("README.md");
  }
  if (packageRelativePathExists(plan.packageDir, "SKILL.md")) {
    merged.add("SKILL.md");
  }
  if (packageRelativePathExists(plan.packageDir, "skills")) {
    merged.add("skills/**");
  }
  return [...merged];
}

function normalizeOpenClawPeerRange(value) {
  const normalized = normalizePackageEntry(value);
  if (!normalized) {
    return "";
  }
  return /^[<>=~^*]|^(?:workspace|npm|file|link|portal|catalog):/u.test(normalized)
    ? normalized
    : `>=${normalized}`;
}

function resolveOpenClawPeerRange(packageJson, rootPackageJson) {
  return (
    normalizeOpenClawPeerRange(packageJson.openclaw?.compat?.pluginApi) ||
    normalizeOpenClawPeerRange(packageJson.peerDependencies?.openclaw) ||
    normalizeOpenClawPeerRange(packageJson.openclaw?.build?.openclawVersion) ||
    normalizeOpenClawPeerRange(rootPackageJson?.version) ||
    normalizeOpenClawPeerRange(packageJson.version)
  );
}

export function resolvePluginNpmRuntimePackagePeerMetadata(plan) {
  const openclawPeerRange = resolveOpenClawPeerRange(plan.packageJson, plan.rootPackageJson);
  if (!openclawPeerRange) {
    throw new Error(
      `cannot infer openclaw peerDependency range for ${plan.pluginDir}; set openclaw.compat.pluginApi or package version`,
    );
  }
  const existingPeerDependencies = getStringRecord(plan.packageJson.peerDependencies);
  const existingPeerDependenciesMeta = getRecord(plan.packageJson.peerDependenciesMeta);
  const existingOpenClawMeta = getRecord(existingPeerDependenciesMeta.openclaw);
  return {
    peerDependencies: {
      ...existingPeerDependencies,
      openclaw: openclawPeerRange,
    },
    peerDependenciesMeta: {
      ...existingPeerDependenciesMeta,
      openclaw: {
        ...existingOpenClawMeta,
        optional: true,
      },
    },
  };
}

export function resolvePluginNpmRuntimeBuildPlan(params) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const packageJsonPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }
  const packageJson = readJsonFile(packageJsonPath);
  const rootPackageJsonPath = path.join(repoRoot, "package.json");
  const rootPackageJson = fs.existsSync(rootPackageJsonPath)
    ? readJsonFile(rootPackageJsonPath)
    : undefined;
  if (!isPublishablePluginPackage(packageJson)) {
    return null;
  }

  const packageEntries = collectPluginSourceEntries(packageJson).map(normalizePackageEntry);
  const requiresRuntimeBuild = packageEntries.some(isTypeScriptEntry);
  if (!requiresRuntimeBuild) {
    return null;
  }

  const pluginDir = path.basename(packageDir);
  const sourceEntries = [
    ...new Set([
      ...packageEntries,
      ...collectTopLevelPublicSurfaceEntries(packageDir).map(normalizePackageEntry),
    ]),
  ].filter(Boolean);
  const entry = Object.fromEntries(
    sourceEntries.map((sourceEntry) => [
      packageEntryKey(sourceEntry),
      path.join(packageDir, sourceEntry.replace(/^\.\//u, "")),
    ]),
  );

  const plan = {
    repoRoot,
    packageDir,
    pluginDir,
    packageJson,
    rootPackageJson,
    sourceEntries,
    entry,
    outDir: path.join(packageDir, "dist"),
    runtimeExtensions: (Array.isArray(packageJson.openclaw?.extensions)
      ? packageJson.openclaw.extensions
      : []
    )
      .map(normalizePackageEntry)
      .filter(Boolean)
      .map(toPackageRuntimeEntry),
    runtimeSetupEntry: normalizePackageEntry(packageJson.openclaw?.setupEntry)
      ? toPackageRuntimeEntry(packageJson.openclaw.setupEntry)
      : undefined,
  };
  return {
    ...plan,
    runtimeBuildOutputs: listPluginNpmRuntimeBuildOutputs(plan),
    packageFiles: resolvePluginNpmRuntimePackageFiles(plan),
    packagePeerMetadata: resolvePluginNpmRuntimePackagePeerMetadata(plan),
  };
}

export async function buildPluginNpmRuntime(params) {
  const plan = resolvePluginNpmRuntimeBuildPlan(params);
  if (!plan) {
    return null;
  }

  fs.rmSync(plan.outDir, { recursive: true, force: true });
  await build({
    clean: false,
    config: false,
    dts: false,
    deps: {
      neverBundle: createNeverBundleDependencyMatcher(plan.packageJson),
    },
    entry: plan.entry,
    env,
    fixedExtension: false,
    logLevel: params.logLevel ?? "info",
    outDir: plan.outDir,
    platform: "node",
  });
  const copiedStaticAssets = copyStaticExtensionAssetsForPackage({
    rootDir: plan.repoRoot,
    pluginDir: plan.pluginDir,
  });
  return {
    ...plan,
    copiedStaticAssets,
  };
}

function parseArgs(argv) {
  const packageDir = argv[0];
  if (!packageDir) {
    throw new Error("usage: node scripts/lib/plugin-npm-runtime-build.mjs <package-dir>");
  }
  return { packageDir };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { packageDir } = parseArgs(process.argv.slice(2));
    const result = await buildPluginNpmRuntime({ packageDir });
    if (result) {
      console.error(
        `[plugin-npm-runtime-build] built ${result.pluginDir} runtime (${result.sourceEntries.length} entries)`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
