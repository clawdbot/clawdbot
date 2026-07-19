// Augments plugin npm package manifests with generated runtime/package metadata.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { packageJsonForShrinkwrap, readShrinkwrapOverrides } from "../generate-npm-shrinkwrap.mjs";
import { resolveNpmRunner } from "../npm-runner.mjs";
import {
  listPluginNpmRuntimeBuildOutputs,
  resolvePluginNpmRuntimeBuildPlan,
} from "./plugin-npm-runtime-build.mjs";

const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA_PATH =
  "src/config/bundled-channel-config-metadata.generated.ts";

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePackageDir(repoRoot, packageDir) {
  return path.isAbsolute(packageDir) ? packageDir : path.resolve(repoRoot, packageDir);
}

function resolvePackageJsonPath(packageDir) {
  return path.join(packageDir, "package.json");
}

function packageRelativePathExists(packageDir, relativePath) {
  return fs.existsSync(path.join(packageDir, relativePath));
}

function normalizePackPath(value) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function packFilePatternMatchesPath(pattern, relativePath) {
  const normalizedPattern = normalizePackPath(pattern).replace(/^!/u, "");
  const normalizedPath = normalizePackPath(relativePath);
  if (!normalizedPattern || !normalizedPath) {
    return false;
  }
  if (normalizedPattern === normalizedPath) {
    return true;
  }

  let source = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    const next = normalizedPattern[index + 1];
    const afterNext = normalizedPattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`, "u").test(normalizedPath);
}

function assertPackageFilesDoNotExcludeRequiredRuntimeArtifacts(plan) {
  const fileRules = Array.isArray(plan.packageJson.files)
    ? plan.packageJson.files.filter((entry) => typeof entry === "string")
    : [];
  const exclusions = fileRules.filter((entry) => normalizePackPath(entry).startsWith("!"));
  if (exclusions.length === 0) {
    return;
  }

  for (const requiredPath of listPluginNpmRuntimeBuildOutputs(plan)) {
    for (const exclusion of exclusions) {
      if (packFilePatternMatchesPath(exclusion, requiredPath)) {
        throw new Error(
          `package file rule '${exclusion}' excludes required package-local runtime file '${requiredPath}' for ${plan.pluginDir}. Remove the negation or publish would advertise a missing runtime entry.`,
        );
      }
    }
  }
}

function assertPluginNpmRuntimeBuildExists(plan) {
  const missing = listPluginNpmRuntimeBuildOutputs(plan).filter(
    (runtimePath) => !packageRelativePathExists(plan.packageDir, runtimePath.replace(/^\.\//u, "")),
  );
  if (missing.length > 0) {
    throw new Error(
      [
        `package-local plugin runtime is missing for ${plan.pluginDir}: ${missing.join(", ")}`,
        `Run node scripts/lib/plugin-npm-runtime-build.mjs ${path.relative(plan.repoRoot, plan.packageDir) || plan.packageDir} before publishing ${plan.packageJson.name ?? plan.pluginDir}.`,
      ].join("\n"),
    );
  }
  assertPackageFilesDoNotExcludeRequiredRuntimeArtifacts(plan);
}

function hasPackageRuntimeDependencies(packageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function listPackageRuntimeDependencyNames(packageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ].toSorted((left, right) => left.localeCompare(right));
}

function listConfiguredBundledDependencyNames(packageJson) {
  if (Array.isArray(packageJson.bundledDependencies)) {
    return packageJson.bundledDependencies.filter((name) => typeof name === "string");
  }
  if (Array.isArray(packageJson.bundleDependencies)) {
    return packageJson.bundleDependencies.filter((name) => typeof name === "string");
  }
  if (packageJson.bundleDependencies === true) {
    return listPackageRuntimeDependencyNames(packageJson);
  }
  return [];
}

/**
 * Resolve an npm command invocation for plugin package scripts.
 * @internal Directly tested script implementation detail.
 */
export function resolvePluginNpmCommand(args, params = {}) {
  return resolveNpmRunner({
    comSpec: params.comSpec,
    env: params.env,
    execPath: params.execPath,
    existsSync: params.existsSync,
    npmArgs: args,
    platform: params.platform,
  });
}

function spawnNpmSync(args, options = {}) {
  const invocation = resolvePluginNpmCommand(args, { env: options.env ?? process.env });
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    ...(invocation.env ? { env: invocation.env } : {}),
    ...(invocation.shell !== undefined ? { shell: invocation.shell } : {}),
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

function spawnCommandSync(command, args, options) {
  if (command === "npm") {
    return spawnNpmSync(args, options);
  }
  return spawnSync(command, args, options);
}

function resolveInstalledPackageDir(packageDir, packageName) {
  return path.join(packageDir, "node_modules", ...packageName.split("/"));
}

function readInstalledPackageJson(packageDir, packageName) {
  const packageJsonPath = path.join(
    resolveInstalledPackageDir(packageDir, packageName),
    "package.json",
  );
  if (!fs.existsSync(packageJsonPath)) {
    return undefined;
  }
  try {
    return {
      packageDir: path.dirname(packageJsonPath),
      packageJson: readJsonFile(packageJsonPath),
    };
  } catch {
    return undefined;
  }
}

function hasInstalledPackage(packageDir, packageName) {
  return fs.existsSync(
    path.join(resolveInstalledPackageDir(packageDir, packageName), "package.json"),
  );
}

function normalizeOptionalDependencySpec(packageDir, dependencyPackageDir, spec) {
  if (typeof spec !== "string" || !spec.trim()) {
    return undefined;
  }
  const trimmed = spec.trim();
  if (!trimmed.startsWith("file:")) {
    return trimmed;
  }
  const fileTarget = trimmed.slice("file:".length);
  if (!fileTarget || path.isAbsolute(fileTarget)) {
    return trimmed;
  }
  const absoluteTarget = path.resolve(dependencyPackageDir, fileTarget);
  const packageRelativeTarget = path.relative(packageDir, absoluteTarget).replaceAll(path.sep, "/");
  return `file:${packageRelativeTarget.startsWith(".") ? packageRelativeTarget : `./${packageRelativeTarget}`}`;
}

function collectMissingOptionalBundledDependencySpecs(packageDir, packageJson) {
  const queue = listConfiguredBundledDependencyNames(packageJson);
  const visited = new Set();
  const missing = new Map();

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || visited.has(packageName)) {
      continue;
    }
    visited.add(packageName);

    const installed = readInstalledPackageJson(packageDir, packageName);
    if (!installed) {
      continue;
    }
    const dependencyNames = [
      ...Object.keys(installed.packageJson.dependencies ?? {}),
      ...Object.keys(installed.packageJson.optionalDependencies ?? {}),
    ].toSorted((left, right) => left.localeCompare(right));
    queue.push(...dependencyNames);

    for (const [optionalName, optionalSpec] of Object.entries(
      installed.packageJson.optionalDependencies ?? {},
    ).toSorted(([left], [right]) => left.localeCompare(right))) {
      if (hasInstalledPackage(packageDir, optionalName)) {
        continue;
      }
      const normalizedSpec = normalizeOptionalDependencySpec(
        packageDir,
        installed.packageDir,
        optionalSpec,
      );
      if (normalizedSpec) {
        missing.set(optionalName, normalizedSpec);
      }
    }
  }

  return [...missing.entries()].map(([name, spec]) => `${name}@${spec}`);
}

function installMissingOptionalBundledDependencies(params) {
  const portableOptionalInstallSpecs = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    const installSpecs = collectMissingOptionalBundledDependencySpecs(
      params.packageDir,
      params.packageJson,
    );
    if (installSpecs.length === 0) {
      return;
    }
    for (const installSpec of installSpecs) {
      const at = installSpec.indexOf("@", installSpec.startsWith("@") ? 1 : 0);
      const packageName = at > 0 ? installSpec.slice(0, at) : installSpec;
      portableOptionalInstallSpecs.set(packageName, installSpec);
    }
    const cumulativeInstallSpecs = [...portableOptionalInstallSpecs.values()].toSorted(
      (left, right) => left.localeCompare(right),
    );
    console.error(
      `[plugin-npm-publish] installing portable optional bundled dependencies for ${params.pluginDir}: ${cumulativeInstallSpecs.join(", ")}`,
    );
    const result = spawnNpmSync(
      [
        "install",
        "--force",
        "--omit=dev",
        "--omit=peer",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--save=false",
        "--loglevel=error",
        ...cumulativeInstallSpecs,
      ],
      {
        cwd: params.packageDir,
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `package-local portable optional dependency install failed for ${params.pluginDir} with exit ${result.status ?? 1}`,
      );
    }
  }
  const remainingSpecs = collectMissingOptionalBundledDependencySpecs(
    params.packageDir,
    params.packageJson,
  );
  if (remainingSpecs.length > 0) {
    throw new Error(
      `package-local portable optional dependency install did not settle for ${params.pluginDir}: ${remainingSpecs.join(", ")}`,
    );
  }
}

function packageOptsOutOfBundledRuntimeDependencies(packageJson) {
  return packageJson?.openclaw?.release?.bundleRuntimeDependencies === false;
}

function shouldBundleDependencies(value, packageJson) {
  if (packageOptsOutOfBundledRuntimeDependencies(packageJson)) {
    return false;
  }
  return value === true || value === "1" || value === "true";
}

function installPackageLocalBundledDependencies(params) {
  const packageJson = params.packageJson;
  if (
    !hasPackageRuntimeDependencies(packageJson) ||
    listConfiguredBundledDependencyNames(packageJson).length === 0
  ) {
    return () => {};
  }

  const shrinkwrapPath = path.join(params.packageDir, "npm-shrinkwrap.json");
  if (!fs.existsSync(shrinkwrapPath)) {
    throw new Error(
      `package-local bundled dependency install requires npm-shrinkwrap.json for ${params.pluginDir}`,
    );
  }

  const nodeModulesPath = path.join(params.packageDir, "node_modules");
  if (fs.existsSync(nodeModulesPath)) {
    throw new Error(
      `package-local bundled dependency install refuses to replace existing node_modules for ${params.pluginDir}`,
    );
  }

  console.error(`[plugin-npm-publish] installing bundled dependencies for ${params.pluginDir}`);
  const packageJsonPath = resolvePackageJsonPath(params.packageDir);
  const packageLockPath = path.join(params.packageDir, "package-lock.json");
  const originalPackageLock = fs.existsSync(packageLockPath)
    ? fs.readFileSync(packageLockPath)
    : undefined;
  const packedPackageJsonText = fs.readFileSync(packageJsonPath, "utf8");
  const installPackageJsonBase = {
    ...params.packageJson,
  };
  delete installPackageJsonBase.peerDependencies;
  delete installPackageJsonBase.peerDependenciesMeta;
  const installPackageJson = packageJsonForShrinkwrap(
    installPackageJsonBase,
    readShrinkwrapOverrides(),
  );
  const installPackageJsonText = `${JSON.stringify(installPackageJson, null, 2)}\n`;
  if (installPackageJsonText !== packedPackageJsonText) {
    // npm validates peer edges against the shrinkwrap during ci even when peers are omitted.
    // The peer metadata belongs in the packed plugin, not in this temporary dependency install.
    fs.writeFileSync(packageJsonPath, installPackageJsonText, "utf8");
  }
  try {
    // npm 12 no longer reads npm-shrinkwrap.json. Stage its identical lockfile shape
    // under the supported name only for the temporary dependency install.
    fs.copyFileSync(shrinkwrapPath, packageLockPath);
    const result = spawnNpmSync(
      [
        "ci",
        "--install-strategy=shallow",
        "--omit=dev",
        "--omit=peer",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--workspaces=false",
        "--loglevel=error",
      ],
      {
        cwd: params.packageDir,
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `package-local bundled dependency install failed for ${params.pluginDir} with exit ${result.status ?? 1}`,
      );
    }
    installMissingOptionalBundledDependencies(params);
  } finally {
    fs.writeFileSync(packageJsonPath, packedPackageJsonText, "utf8");
    if (originalPackageLock) {
      fs.writeFileSync(packageLockPath, originalPackageLock);
    } else {
      fs.rmSync(packageLockPath, { force: true });
    }
  }
  return () => {
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  };
}

/**
 * Build the package.json that should be used while packaging a plugin for npm.
 * @internal Directly tested script implementation detail.
 */
export function resolveAugmentedPluginNpmPackageJson(params) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const packageJsonPath = resolvePackageJsonPath(packageDir);
  if (!fs.existsSync(packageJsonPath)) {
    return {
      packageJsonPath,
      packageDir,
      repoRoot,
      changed: false,
      packageJson: undefined,
      reason: "missing-package-json",
    };
  }

  const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot, packageDir });
  if (!plan) {
    return {
      packageJsonPath,
      packageDir,
      repoRoot,
      changed: false,
      packageJson: undefined,
      reason: "no-runtime-build",
    };
  }
  assertPluginNpmRuntimeBuildExists(plan);

  const packageJson = {
    ...plan.packageJson,
    files: plan.packageFiles,
    peerDependencies: plan.packagePeerMetadata.peerDependencies,
    peerDependenciesMeta: plan.packagePeerMetadata.peerDependenciesMeta,
    openclaw: {
      ...plan.packageJson.openclaw,
      runtimeExtensions: plan.runtimeExtensions,
      ...(plan.runtimeSetupEntry
        ? {
            setupEntry: plan.runtimeSetupEntry,
            runtimeSetupEntry: plan.runtimeSetupEntry,
          }
        : {}),
    },
  };
  if (shouldBundleDependencies(params.bundleDependencies, plan.packageJson)) {
    packageJson.bundledDependencies = listPackageRuntimeDependencyNames(packageJson);
    delete packageJson.bundleDependencies;
    delete packageJson.devDependencies;
  }
  const changed = JSON.stringify(packageJson) !== JSON.stringify(plan.packageJson);
  return {
    packageJsonPath,
    packageDir,
    repoRoot,
    changed,
    packageJson,
    pluginDir: plan.pluginDir,
    bundleDependencies: shouldBundleDependencies(params.bundleDependencies, plan.packageJson),
    reason: changed ? "package-local-runtime" : "unchanged",
  };
}

/** Read generated bundled channel config metadata keyed by plugin id. */
export function readGeneratedBundledChannelConfigs(repoRoot) {
  const metadataPath = path.join(repoRoot, GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA_PATH);
  if (!fs.existsSync(metadataPath)) {
    return new Map();
  }
  const source = fs.readFileSync(metadataPath, "utf8");
  const entries = readGeneratedBundledChannelConfigEntries(source);
  if (!Array.isArray(entries)) {
    return new Map();
  }

  const byPlugin = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.pluginId !== "string" ||
      typeof entry.channelId !== "string" ||
      !entry.schema ||
      typeof entry.schema !== "object"
    ) {
      continue;
    }
    const pluginConfigs = byPlugin.get(entry.pluginId) ?? {};
    pluginConfigs[entry.channelId] = {
      schema: entry.schema,
      ...(typeof entry.label === "string" && entry.label ? { label: entry.label } : {}),
      ...(typeof entry.description === "string" && entry.description
        ? { description: entry.description }
        : {}),
      ...(entry.uiHints && typeof entry.uiHints === "object" ? { uiHints: entry.uiHints } : {}),
    };
    byPlugin.set(entry.pluginId, pluginConfigs);
  }
  return byPlugin;
}

function readGeneratedBundledChannelConfigEntries(source) {
  const legacyMatch = source.match(
    /export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = ([\s\S]*?) as const;/u,
  );
  if (legacyMatch?.[1]) {
    try {
      return JSON5.parse(legacyMatch[1]);
    } catch {
      return undefined;
    }
  }

  const compactMatch = source.match(
    /const RAW_BUNDLED_CHANNEL_CONFIG_METADATA = \[([\s\S]*?)\]\.join\(""\);/u,
  );
  if (!compactMatch?.[1]) {
    return undefined;
  }
  try {
    const chunks = JSON5.parse(`[${compactMatch[1]}]`);
    if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk !== "string")) {
      return undefined;
    }
    return JSON.parse(chunks.join(""));
  } catch {
    return undefined;
  }
}

/** Merge generated channel config schemas into a plugin manifest without clobbering labels. */
export function mergeGeneratedChannelConfigs(manifest, generatedChannelConfigs) {
  if (!generatedChannelConfigs || Object.keys(generatedChannelConfigs).length === 0) {
    return manifest;
  }
  const existingChannelConfigs =
    manifest.channelConfigs && typeof manifest.channelConfigs === "object"
      ? manifest.channelConfigs
      : {};
  const channelConfigs = { ...existingChannelConfigs };
  for (const [channelId, generated] of Object.entries(generatedChannelConfigs)) {
    const existing =
      existingChannelConfigs[channelId] && typeof existingChannelConfigs[channelId] === "object"
        ? existingChannelConfigs[channelId]
        : {};
    channelConfigs[channelId] = {
      ...generated,
      ...existing,
      schema: generated.schema,
      ...(generated.uiHints || existing.uiHints
        ? { uiHints: { ...generated.uiHints, ...existing.uiHints } }
        : {}),
      ...(existing.label || generated.label ? { label: existing.label ?? generated.label } : {}),
      ...(existing.description || generated.description
        ? { description: existing.description ?? generated.description }
        : {}),
    };
  }
  return {
    ...manifest,
    channelConfigs,
  };
}

/**
 * Build the plugin manifest that should be used while packaging a plugin for npm.
 * @internal Directly tested script implementation detail.
 */
export function resolveAugmentedPluginNpmManifest(params) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const manifestPath = path.join(packageDir, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      manifestPath,
      pluginId: path.basename(packageDir),
      changed: false,
      manifest: undefined,
      reason: "missing-manifest",
    };
  }

  const manifest = readJsonFile(manifestPath);
  const pluginId =
    typeof manifest.id === "string" && manifest.id ? manifest.id : path.basename(packageDir);
  const generatedChannelConfigs = readGeneratedBundledChannelConfigs(repoRoot).get(pluginId);
  const augmentedManifest = mergeGeneratedChannelConfigs(manifest, generatedChannelConfigs);
  const changed = JSON.stringify(augmentedManifest) !== JSON.stringify(manifest);
  return {
    manifestPath,
    pluginId,
    changed,
    manifest: augmentedManifest,
    reason: changed ? "generated-channel-configs" : "unchanged",
  };
}

/**
 * Temporarily write augmented manifest/package metadata while a packaging callback runs.
 * @internal Directly tested script implementation detail.
 */
export function withAugmentedPluginNpmManifestForPackage(params, callback) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const packageJsonPath = resolvePackageJsonPath(packageDir);
  const packageJsonForBundlePolicy = fs.existsSync(packageJsonPath)
    ? readJsonFile(packageJsonPath)
    : undefined;
  const bundleDependencies = shouldBundleDependencies(
    params.bundleDependencies,
    packageJsonForBundlePolicy,
  );
  const resolvedManifest = resolveAugmentedPluginNpmManifest({
    repoRoot,
    packageDir,
  });
  const resolvedPackageJson = resolveAugmentedPluginNpmPackageJson({
    repoRoot,
    packageDir,
    bundleDependencies,
  });

  if (
    (!resolvedManifest.changed || !resolvedManifest.manifest) &&
    (!resolvedPackageJson.changed || !resolvedPackageJson.packageJson)
  ) {
    return callback({
      ...resolvedManifest,
      packageDir,
      repoRoot,
      applied: false,
      packageJsonApplied: false,
    });
  }

  const originalManifest =
    resolvedManifest.changed && resolvedManifest.manifest
      ? fs.readFileSync(resolvedManifest.manifestPath, "utf8")
      : undefined;
  const originalPackageJson =
    resolvedPackageJson.changed && resolvedPackageJson.packageJson
      ? fs.readFileSync(resolvedPackageJson.packageJsonPath, "utf8")
      : undefined;
  if (resolvedManifest.changed && resolvedManifest.manifest) {
    console.error(
      `[plugin-npm-publish] overlaying generated channel config metadata for ${resolvedManifest.pluginId}`,
    );
    writeJsonFile(resolvedManifest.manifestPath, resolvedManifest.manifest);
  }
  if (resolvedPackageJson.changed && resolvedPackageJson.packageJson) {
    console.error(
      `[plugin-npm-publish] overlaying package-local runtime metadata for ${resolvedPackageJson.pluginDir}`,
    );
    writeJsonFile(resolvedPackageJson.packageJsonPath, resolvedPackageJson.packageJson);
  }
  let cleanupBundledDependencies = () => {};
  try {
    if (bundleDependencies && resolvedPackageJson.packageJson) {
      cleanupBundledDependencies = installPackageLocalBundledDependencies({
        packageDir,
        packageJson: resolvedPackageJson.packageJson,
        pluginDir: resolvedPackageJson.pluginDir ?? path.basename(packageDir),
      });
    }
    return callback({
      ...resolvedManifest,
      packageDir,
      repoRoot,
      applied: resolvedManifest.changed && Boolean(resolvedManifest.manifest),
      packageJsonApplied: resolvedPackageJson.changed && Boolean(resolvedPackageJson.packageJson),
    });
  } finally {
    cleanupBundledDependencies();
    if (originalManifest !== undefined) {
      fs.writeFileSync(resolvedManifest.manifestPath, originalManifest, "utf8");
    }
    if (originalPackageJson !== undefined) {
      fs.writeFileSync(resolvedPackageJson.packageJsonPath, originalPackageJson, "utf8");
    }
  }
}

const RUN_USAGE =
  "usage: node scripts/lib/plugin-npm-package-manifest.mjs --run <package-dir> -- <command> [args...]";

function readRunPackageDir(argv) {
  const packageDir = argv[1];
  if (!packageDir || packageDir.startsWith("--")) {
    throw new Error(RUN_USAGE);
  }
  return packageDir;
}

/** @internal Directly tested script implementation detail. */
export function parseRunArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { help: true, packageDir: "", command: "", args: [] };
  }
  if (argv[0] !== "--run") {
    throw new Error(RUN_USAGE);
  }
  const packageDir = readRunPackageDir(argv);
  const separatorIndex = argv.indexOf("--", 2);
  if (!packageDir || separatorIndex === -1 || separatorIndex === argv.length - 1) {
    throw new Error(RUN_USAGE);
  }
  if (separatorIndex !== 2) {
    throw new Error(`unexpected plugin npm package manifest run argument: ${argv[2]}`);
  }
  return {
    packageDir,
    command: argv[separatorIndex + 1],
    args: argv.slice(separatorIndex + 2),
  };
}

function main(argv = process.argv.slice(2)) {
  const parsedArgs = parseRunArgs(argv);
  if (parsedArgs.help) {
    console.log(RUN_USAGE);
    return 0;
  }
  const { packageDir, command, args } = parsedArgs;
  return withAugmentedPluginNpmManifestForPackage(
    {
      packageDir,
      bundleDependencies: process.env.OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES,
    },
    ({ packageDir: cwd }) => {
      const result = spawnCommandSync(command, args, {
        cwd,
        env: process.env,
        stdio: "inherit",
      });
      if (result.error) {
        throw result.error;
      }
      return result.status ?? 1;
    },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
