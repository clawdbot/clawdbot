import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
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
      ...(plan.runtimeSetupEntry ? { runtimeSetupEntry: plan.runtimeSetupEntry } : {}),
    },
  };
  const changed = JSON.stringify(packageJson) !== JSON.stringify(plan.packageJson);
  return {
    packageJsonPath,
    packageDir,
    repoRoot,
    changed,
    packageJson,
    pluginDir: plan.pluginDir,
    reason: changed ? "package-local-runtime" : "unchanged",
  };
}

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

export function withAugmentedPluginNpmManifestForPackage(params, callback) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const resolvedManifest = resolveAugmentedPluginNpmManifest({
    repoRoot,
    packageDir,
  });
  const resolvedPackageJson = resolveAugmentedPluginNpmPackageJson({
    repoRoot,
    packageDir,
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
  try {
    return callback({
      ...resolvedManifest,
      packageDir,
      repoRoot,
      applied: resolvedManifest.changed && Boolean(resolvedManifest.manifest),
      packageJsonApplied: resolvedPackageJson.changed && Boolean(resolvedPackageJson.packageJson),
    });
  } finally {
    if (originalManifest !== undefined) {
      fs.writeFileSync(resolvedManifest.manifestPath, originalManifest, "utf8");
    }
    if (originalPackageJson !== undefined) {
      fs.writeFileSync(resolvedPackageJson.packageJsonPath, originalPackageJson, "utf8");
    }
  }
}

function parseRunArgs(argv) {
  if (argv[0] !== "--run") {
    throw new Error(
      "usage: node scripts/lib/plugin-npm-package-manifest.mjs --run <package-dir> -- <command> [args...]",
    );
  }
  const packageDir = argv[1];
  const separatorIndex = argv.indexOf("--", 2);
  if (!packageDir || separatorIndex === -1 || separatorIndex === argv.length - 1) {
    throw new Error(
      "usage: node scripts/lib/plugin-npm-package-manifest.mjs --run <package-dir> -- <command> [args...]",
    );
  }
  return {
    packageDir,
    command: argv[separatorIndex + 1],
    args: argv.slice(separatorIndex + 2),
  };
}

function main(argv = process.argv.slice(2)) {
  const { packageDir, command, args } = parseRunArgs(argv);
  return withAugmentedPluginNpmManifestForPackage({ packageDir }, ({ packageDir: cwd }) => {
    const result = spawnSync(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    return result.status ?? 1;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
