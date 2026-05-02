import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";

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

function readGeneratedBundledChannelConfigs(repoRoot) {
  const metadataPath = path.join(repoRoot, GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA_PATH);
  if (!fs.existsSync(metadataPath)) {
    return new Map();
  }
  const source = fs.readFileSync(metadataPath, "utf8");
  const match = source.match(
    /export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = ([\s\S]*?) as const;/u,
  );
  if (!match?.[1]) {
    return new Map();
  }

  let entries;
  try {
    entries = JSON5.parse(match[1]);
  } catch {
    return new Map();
  }
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

function mergeGeneratedChannelConfigs(manifest, generatedChannelConfigs) {
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
  const resolved = resolveAugmentedPluginNpmManifest({
    repoRoot,
    packageDir,
  });

  if (!resolved.changed || !resolved.manifest) {
    return callback({
      ...resolved,
      packageDir,
      repoRoot,
      applied: false,
    });
  }

  const originalManifest = fs.readFileSync(resolved.manifestPath, "utf8");
  console.error(
    `[plugin-npm-publish] overlaying generated channel config metadata for ${resolved.pluginId}`,
  );
  writeJsonFile(resolved.manifestPath, resolved.manifest);
  try {
    return callback({
      ...resolved,
      packageDir,
      repoRoot,
      applied: true,
    });
  } finally {
    fs.writeFileSync(resolved.manifestPath, originalManifest, "utf8");
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
