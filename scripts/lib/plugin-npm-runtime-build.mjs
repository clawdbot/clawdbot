// Builds package-local runtime dist files for publishable bundled plugins.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import {
  collectPluginSourceEntries,
  collectTopLevelPublicSurfaceEntries,
} from "./bundled-plugin-build-entries.mjs";
import {
  listMissingPackageStaticAssetSources,
  runPackageAssetBuild,
} from "./plugin-npm-runtime-assets.mjs";
import { copyStaticExtensionAssetsForPackage } from "./static-extension-assets.mjs";

const env = {
  NODE_ENV: "production",
};

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** Return whether a plugin package publishes through an artifact release workflow. */
function isPublishablePluginPackage(packageJson) {
  return (
    packageJson.openclaw?.release?.publishToNpm === true ||
    packageJson.openclaw?.release?.publishToClawHub === true
  );
}

function normalizePackageEntry(value) {
  return typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
}

function isTypeScriptEntry(entry) {
  return /\.(?:c|m)?ts$/u.test(entry);
}

function resolveRuntimeBuildFormat(packageJson) {
  return packageJson.openclaw?.build?.runtimeFormat === "cjs" ? "cjs" : "esm";
}

function runtimeBuildExtension(runtimeFormat) {
  return runtimeFormat === "cjs" ? ".cjs" : ".js";
}

function toPackageRuntimeEntry(entry, runtimeFormat = "esm") {
  const normalized = normalizePackageEntry(entry).replace(/^\.\//u, "");
  return `./dist/${normalized.replace(/\.[^.]+$/u, runtimeBuildExtension(runtimeFormat))}`;
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

const HOST_PLUGIN_SDK_IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\b(?:require|_+require\d*)\(\s*)["'](openclaw\/plugin-sdk\/[^"']+)["']/gu;

function listRuntimeJavaScriptFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return listRuntimeJavaScriptFiles(entryPath);
      }
      return /\.(?:c|m)?js$/u.test(entry.name) ? [entryPath] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * List host SDK imports emitted by a built plugin runtime but absent from package exports.
 * @param {{ repoRoot: string; outDir: string }} plan
 */
export function listMissingPluginNpmRuntimeHostExports(plan) {
  const hostImports = new Set();
  for (const runtimePath of listRuntimeJavaScriptFiles(plan.outDir)) {
    const source = fs.readFileSync(runtimePath, "utf8");
    for (const match of source.matchAll(HOST_PLUGIN_SDK_IMPORT_RE)) {
      const specifier = match[1];
      if (specifier) {
        hostImports.add(specifier);
      }
    }
  }
  if (hostImports.size === 0) {
    return [];
  }

  const hostPackageJson = readJsonFile(path.join(plan.repoRoot, "package.json"));
  const hostExports = new Set(Object.keys(hostPackageJson.exports ?? {}));
  return [...hostImports]
    .filter((specifier) => !hostExports.has(specifier.replace(/^openclaw/u, ".")))
    .toSorted((left, right) => left.localeCompare(right));
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

/**
 * List extension package dirs whose package metadata enables artifact publishing.
 * @internal Shared repository-script contract.
 */
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

/** List package-local runtime output files expected from a runtime build plan. */
export function listPluginNpmRuntimeBuildOutputs(plan) {
  const extension = runtimeBuildExtension(plan.runtimeFormat);
  return Object.keys(plan.entry)
    .map((entryKey) => `./dist/${entryKey}${extension}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function rewriteCommonJsRuntimeSpecifiers(plan) {
  if (plan.runtimeFormat !== "cjs") {
    return;
  }
  const specifierRewrites = new Map(
    plan.runtimeBuildOutputs.map((output) => {
      const cjsSpecifier = output.replace(/^\.\/dist\//u, "./");
      return [cjsSpecifier.replace(/\.cjs$/u, ".js"), cjsSpecifier];
    }),
  );

  for (const output of plan.runtimeBuildOutputs) {
    const outputPath = path.join(plan.packageDir, output.replace(/^\.\//u, ""));
    let text = fs.readFileSync(outputPath, "utf8");
    const original = text;
    // Source entries stay .js for the root bundled build; package-local CJS
    // artifacts must point at their generated .cjs sidecars instead.
    for (const [fromSpecifier, toSpecifier] of specifierRewrites) {
      text = text.replaceAll(
        `specifier: ${JSON.stringify(fromSpecifier)}`,
        `specifier: ${JSON.stringify(toSpecifier)}`,
      );
    }
    if (text !== original) {
      fs.writeFileSync(outputPath, text, "utf8");
    }
  }
}

/** Resolve package `files` entries needed for runtime build outputs and plugin metadata. */
function resolvePluginNpmRuntimePackageFiles(plan) {
  const merged = new Set(
    Array.isArray(plan.packageJson.files)
      ? plan.packageJson.files.filter((entry) => typeof entry === "string")
      : [],
  );
  merged.add("dist/**");
  if (packageRelativePathExists(plan.packageDir, "openclaw.plugin.json")) {
    merged.add("openclaw.plugin.json");
  }
  if (packageRelativePathExists(plan.packageDir, "npm-shrinkwrap.json")) {
    merged.add("npm-shrinkwrap.json");
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

/** Resolve package peer dependency metadata for the OpenClaw plugin API. */
function resolvePluginNpmRuntimePackagePeerMetadata(plan) {
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

/** Resolve the package-local runtime build plan for one publishable plugin package. */
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

  const runtimeFormat = resolveRuntimeBuildFormat(packageJson);
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
    runtimeFormat,
    runtimeExtensions: (Array.isArray(packageJson.openclaw?.extensions)
      ? packageJson.openclaw.extensions
      : []
    )
      .map(normalizePackageEntry)
      .filter(Boolean)
      .map((runtimeEntry) => toPackageRuntimeEntry(runtimeEntry, runtimeFormat)),
    runtimeSetupEntry: normalizePackageEntry(packageJson.openclaw?.setupEntry)
      ? toPackageRuntimeEntry(packageJson.openclaw.setupEntry, runtimeFormat)
      : undefined,
  };
  return {
    ...plan,
    runtimeBuildOutputs: listPluginNpmRuntimeBuildOutputs(plan),
    packageFiles: resolvePluginNpmRuntimePackageFiles(plan),
    packagePeerMetadata: resolvePluginNpmRuntimePackagePeerMetadata(plan),
  };
}

/**
 * Build package-local runtime files and static assets for one plugin package.
 * @internal Shared repository-script contract.
 */
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
    fixedExtension: plan.runtimeFormat === "cjs",
    format: plan.runtimeFormat,
    logLevel: params.logLevel ?? "info",
    outDir: plan.outDir,
    platform: "node",
  });
  const missingHostExports = listMissingPluginNpmRuntimeHostExports(plan);
  if (missingHostExports.length > 0) {
    throw new Error(
      `${plan.pluginDir} runtime imports missing OpenClaw host exports: ${missingHostExports.join(", ")}`,
    );
  }
  rewriteCommonJsRuntimeSpecifiers(plan);
  const assetBuildCommand = runPackageAssetBuild(plan);
  const missingStaticAssets = listMissingPackageStaticAssetSources(plan);
  if (missingStaticAssets.length > 0) {
    throw new Error(
      `${plan.pluginDir} missing static asset source(s): ${missingStaticAssets.join(", ")}`,
    );
  }
  const copiedStaticAssets = copyStaticExtensionAssetsForPackage({
    rootDir: plan.repoRoot,
    pluginDir: plan.pluginDir,
  });
  return {
    ...plan,
    assetBuildCommand,
    copiedStaticAssets,
  };
}

function usage() {
  return "usage: node scripts/lib/plugin-npm-runtime-build.mjs <package-dir>";
}

function readPackageDirArg(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const packageDir = args[0];
  if (packageDir === "--help" || packageDir === "-h") {
    return { help: true, packageDir: "" };
  }
  if (!packageDir || packageDir.startsWith("-")) {
    throw new Error(usage());
  }
  const extraArg = args[1];
  if (extraArg) {
    throw new Error(`unexpected plugin npm runtime build argument: ${extraArg}`);
  }
  return { packageDir };
}

/** @internal Directly tested script implementation detail. */
export function parseArgs(argv) {
  return readPackageDirArg(argv);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    const { packageDir } = args;
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
