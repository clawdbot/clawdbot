// Builds package-local runtime dist files for publishable bundled plugins.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectPluginSourceEntries,
  collectTopLevelPublicSurfaceEntries,
  pluginRuntimeExtension,
  resolvePluginRuntimeFormat,
} from "./bundled-plugin-build-entries.mjs";
import { assertRealOutputRoot } from "./output-root-guard.mjs";
import {
  listMissingPackageStaticAssetSources,
  runPackageAssetBuild,
} from "./plugin-npm-runtime-assets.mts";
import { isRecord } from "./record-shared.mjs";
import { copyStaticExtensionAssetsForPackage } from "./static-extension-assets.mts";

const env = {
  NODE_ENV: "production",
};

type JsonRecord = Record<string, unknown>;

export type PluginPackageJson = JsonRecord & {
  dependencies?: JsonRecord;
  openclaw?: {
    assetScripts?: { build?: unknown };
    build?: { bundledDist?: unknown; openclawVersion?: unknown; runtimeFormat?: unknown };
    compat?: { pluginApi?: unknown };
    release?: {
      bundleRuntimeDependencies?: unknown;
      publishToClawHub?: unknown;
      publishToNpm?: unknown;
    };
    [key: string]: unknown;
  };
  optionalDependencies?: JsonRecord;
  peerDependencies?: JsonRecord;
};

type RuntimeBuildFormat = "esm" | "cjs";
type PluginNpmRuntimeBuildParams = {
  repoRoot?: string;
  packageDir: string;
  logLevel?: "silent" | "error" | "warn" | "info";
};

function readJsonFile(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as PluginPackageJson;
}

/** Return whether a plugin package publishes through an artifact release workflow. */
function isPublishablePluginPackage(packageJson: PluginPackageJson) {
  return (
    packageJson.openclaw?.release?.publishToNpm === true ||
    packageJson.openclaw?.release?.publishToClawHub === true
  );
}

function normalizePackageEntry(value: unknown) {
  return typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
}

function isTypeScriptEntry(entry: string) {
  return /\.(?:c|m)?ts$/u.test(entry);
}

function toPackageRuntimeEntry(entry: string, runtimeFormat: RuntimeBuildFormat = "esm") {
  const normalized = normalizePackageEntry(entry).replace(/^\.\//u, "");
  return `./dist/${normalized.replace(/\.[^.]+$/u, pluginRuntimeExtension(runtimeFormat))}`;
}

function collectExternalDependencyNames(packageJson: PluginPackageJson) {
  return new Set(
    [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ].filter(Boolean),
  );
}

function getStringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entryValue]) => typeof entryValue === "string" && entryValue.trim().length > 0,
    ),
  );
}

function createNeverBundleDependencyMatcher(packageJson: PluginPackageJson) {
  const externalDependencies = collectExternalDependencyNames(packageJson);
  return (id: string) => {
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

function listRuntimeJavaScriptFiles(rootDir: string): string[] {
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
export function listMissingPluginNpmRuntimeHostExports(plan: { repoRoot: string; outDir: string }) {
  const hostImports = new Set<string>();
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

function packageEntryKey(entry: string) {
  return normalizePackageEntry(entry)
    .replace(/^\.\//u, "")
    .replace(/\.[^.]+$/u, "");
}

function resolvePackageDir(repoRoot: string, packageDir: string) {
  return path.isAbsolute(packageDir) ? packageDir : path.resolve(repoRoot, packageDir);
}

function packageRelativePathExists(packageDir: string, relativePath: string) {
  return fs.existsSync(path.join(packageDir, relativePath));
}

/**
 * List extension package dirs whose package metadata enables artifact publishing.
 * @internal Shared repository-script contract.
 */
export function listPublishablePluginPackageDirs(params: { repoRoot?: string } = {}) {
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
export function listPluginNpmRuntimeBuildOutputs(plan: {
  runtimeFormat: RuntimeBuildFormat;
  entry: Record<string, string>;
}) {
  const extension = pluginRuntimeExtension(plan.runtimeFormat);
  return Object.keys(plan.entry)
    .map((entryKey) => `./dist/${entryKey}${extension}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function rewriteCommonJsRuntimeSpecifiers(plan: PluginNpmRuntimeBuildPlan) {
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
function resolvePluginNpmRuntimePackageFiles(plan: {
  packageJson: PluginPackageJson;
  packageDir: string;
}) {
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

function normalizeOpenClawPeerRange(value: unknown) {
  const normalized = normalizePackageEntry(value);
  if (!normalized) {
    return "";
  }
  return /^[<>=~^*]|^(?:workspace|npm|file|link|portal|catalog):/u.test(normalized)
    ? normalized
    : `>=${normalized}`;
}

function resolveOpenClawPeerRange(
  packageJson: PluginPackageJson,
  rootPackageJson: PluginPackageJson | undefined,
) {
  return (
    normalizeOpenClawPeerRange(packageJson.openclaw?.compat?.pluginApi) ||
    normalizeOpenClawPeerRange(packageJson.peerDependencies?.openclaw) ||
    normalizeOpenClawPeerRange(packageJson.openclaw?.build?.openclawVersion) ||
    normalizeOpenClawPeerRange(rootPackageJson?.version) ||
    normalizeOpenClawPeerRange(packageJson.version)
  );
}

/** Resolve package peer dependency metadata for the OpenClaw plugin API. */
function resolvePluginNpmRuntimePackagePeerMetadata(plan: {
  packageJson: PluginPackageJson;
  rootPackageJson: PluginPackageJson | undefined;
  pluginDir: string;
}) {
  const openclawPeerRange = resolveOpenClawPeerRange(plan.packageJson, plan.rootPackageJson);
  if (!openclawPeerRange) {
    throw new Error(
      `cannot infer openclaw peerDependency range for ${plan.pluginDir}; set openclaw.compat.pluginApi or package version`,
    );
  }
  const existingPeerDependencies = getStringRecord(plan.packageJson.peerDependencies);
  const existingPeerDependenciesMeta = isRecord(plan.packageJson.peerDependenciesMeta)
    ? plan.packageJson.peerDependenciesMeta
    : {};
  const existingOpenClawMeta = isRecord(existingPeerDependenciesMeta.openclaw)
    ? existingPeerDependenciesMeta.openclaw
    : {};
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

/** Resolve the package-local runtime build plan for one plugin package. */
export function resolvePluginNpmRuntimeBuildPlan(params: PluginNpmRuntimeBuildParams) {
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
  // Compilation also serves private source-checkout plugins. Publication selection
  // belongs to listPublishablePluginPackageDirs, not the runtime graph builder.
  if (!Array.isArray(packageJson.openclaw?.extensions)) {
    return null;
  }

  const runtimeFormat = resolvePluginRuntimeFormat(packageJson);
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
  const setupEntry = normalizePackageEntry(packageJson.openclaw?.setupEntry);

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
    runtimeSetupEntry: setupEntry ? toPackageRuntimeEntry(setupEntry, runtimeFormat) : undefined,
  };
  return {
    ...plan,
    runtimeBuildOutputs: listPluginNpmRuntimeBuildOutputs(plan),
    packageFiles: resolvePluginNpmRuntimePackageFiles(plan),
    packagePeerMetadata: resolvePluginNpmRuntimePackagePeerMetadata(plan),
  };
}

export type PluginNpmRuntimeBuildPlan = NonNullable<
  ReturnType<typeof resolvePluginNpmRuntimeBuildPlan>
>;

/**
 * Build isolated runtime files and static assets for publication or source-checkout use.
 * @internal Shared repository-script contract.
 */
export async function buildPluginNpmRuntime(params: PluginNpmRuntimeBuildParams) {
  const plan = resolvePluginNpmRuntimeBuildPlan(params);
  if (!plan) {
    return null;
  }

  const { build } = await import("tsdown");
  assertRealOutputRoot(plan.outDir);
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

async function preparePluginNativeImport(params: PluginNpmRuntimeBuildParams) {
  // Source setup is opt-in; publication and root builds must remain artifact-only.
  const { readRootJsonObjectSync } = await import("../../src/infra/json-files.js");
  const { linkOpenClawPeerDependencies, resolveOpenClawHostDependency } =
    await import("../../src/plugins/plugin-peer-link.js");
  const { isSourceCheckoutRoot } = await import("../postinstall-bundled-plugins.mjs");
  const repoRoot = fs.realpathSync(params.repoRoot ?? ".");
  const hostManifest = readRootJsonObjectSync({
    rootDir: repoRoot,
    relativePath: "package.json",
    boundaryLabel: "OpenClaw source checkout",
  });
  if (
    !hostManifest.ok ||
    hostManifest.value.name !== "openclaw" ||
    !isSourceCheckoutRoot({ packageRoot: repoRoot })
  ) {
    throw new Error("Native-import preparation must run from an OpenClaw source checkout root.");
  }
  const packageDir = path.resolve(repoRoot, params.packageDir);
  if (
    path.dirname(packageDir) !== path.join(repoRoot, "extensions") ||
    !fs.lstatSync(packageDir, { throwIfNoEntry: false })?.isDirectory() ||
    fs.realpathSync(packageDir) !== packageDir
  ) {
    throw new Error(
      "Select a real immediate extensions/<package> directory in this checkout; symlinked packages are not supported.",
    );
  }
  const manifest = readRootJsonObjectSync({
    rootDir: packageDir,
    relativePath: "package.json",
    boundaryLabel: "selected source plugin package",
  });
  if (!manifest.ok) {
    throw new Error(
      `Could not safely read ${packageDir}/package.json; use a regular file containing a JSON object.`,
    );
  }
  const dependency = resolveOpenClawHostDependency(manifest.value);
  if (!dependency) {
    throw new Error(
      `${params.packageDir} does not declare openclaw in peerDependencies or dependencies; no host link to prepare.`,
    );
  }
  if (
    !fs.statSync(path.join(repoRoot, "dist/plugin-sdk"), { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new Error("Host SDK output is missing; build OpenClaw before preparing native imports.");
  }
  const runtimeFormat = resolvePluginRuntimeFormat(manifest.value);
  const outDir = path.join(packageDir, "dist");
  for (const entry of collectPluginSourceEntries(manifest.value)) {
    const output = path.resolve(packageDir, toPackageRuntimeEntry(entry, runtimeFormat));
    const relative = path.relative(outDir, output);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative) ||
      !fs.statSync(output, { throwIfNoEntry: false })?.isFile()
    ) {
      throw new Error(
        `Missing package-local runtime output for ${entry}; run node scripts/lib/plugin-npm-runtime-build.mjs ${params.packageDir} first.`,
      );
    }
  }
  const result = await linkOpenClawPeerDependencies({
    installedDir: packageDir,
    hostRoot: repoRoot,
    peerDependencies: { openclaw: dependency.spec },
    logger: { warn: (message) => console.error(message) },
  });
  if (result.skipped > 0) {
    throw new Error(
      `Could not prepare ${params.packageDir}: inspect node_modules/openclaw and the warning above; move conflicting paths aside and rerun --prepare-native-import.`,
    );
  }
  console.error(
    `[plugin-npm-runtime-build] prepared ${path.basename(packageDir)} host link for native imports (artifacts unchanged)`,
  );
}

function usage() {
  return (
    "usage: node scripts/lib/plugin-npm-runtime-build.mjs <package-dir> [--prepare-native-import]\n" +
    "  --prepare-native-import  Prepare an already-built source package without rebuilding artifacts; run from the checkout root."
  );
}

function readPackageDirArg(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const prepareIndex = args.indexOf("--prepare-native-import");
  if (prepareIndex !== -1) {
    args.splice(prepareIndex, 1);
  }
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
  return prepareIndex === -1 ? { packageDir } : { packageDir, prepareNativeImport: true };
}

/** @internal Directly tested script implementation detail. */
export function parseArgs(argv: string[]) {
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
    const result = args.prepareNativeImport
      ? await preparePluginNativeImport({ packageDir })
      : await buildPluginNpmRuntime({ packageDir });
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
