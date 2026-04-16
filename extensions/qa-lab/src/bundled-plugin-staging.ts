import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const QA_ALWAYS_STAGE_RUNTIME_PLUGIN_IDS = Object.freeze([
  "image-generation-core",
  "media-understanding-core",
  "speech-core",
]);
const QA_OPENAI_PLUGIN_ID = "openai";
const QA_BUNDLED_PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeQaBundledPluginId(pluginId: string) {
  if (!QA_BUNDLED_PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(`invalid QA bundled plugin id: ${pluginId}`);
  }
}

function parseStableSemverFloor(value: string | undefined) {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10),
    patch: Number.parseInt(match[3] ?? "", 10),
    label: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function compareSemverFloors(
  left: ReturnType<typeof parseStableSemverFloor>,
  right: ReturnType<typeof parseStableSemverFloor>,
) {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

function isQaOpenAiResponsesProviderConfig(config: ModelProviderConfig) {
  return (
    config.api === "openai-responses" ||
    config.models.some((model) => model.api === "openai-responses")
  );
}

export function resolveQaBundledPluginSourceDir(params: { repoRoot: string; pluginId: string }) {
  assertSafeQaBundledPluginId(params.pluginId);
  const candidates = [
    path.join(params.repoRoot, "dist", "extensions", params.pluginId),
    path.join(params.repoRoot, "dist-runtime", "extensions", params.pluginId),
    path.join(params.repoRoot, "extensions", params.pluginId),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveQaBundledPluginScanRoots(repoRoot: string) {
  return [
    path.join(repoRoot, "dist", "extensions"),
    path.join(repoRoot, "dist-runtime", "extensions"),
    path.join(repoRoot, "extensions"),
  ].filter((candidate, index, all) => existsSync(candidate) && all.indexOf(candidate) === index);
}

export async function resolveQaOwnerPluginIdsForProviderIds(params: {
  repoRoot: string;
  providerIds: readonly string[];
  providerConfigs?: Record<string, ModelProviderConfig>;
}) {
  const providerIds = [
    ...new Set(params.providerIds.map((providerId) => providerId.trim())),
  ].filter((providerId) => providerId.length > 0);
  if (providerIds.length === 0) {
    return [];
  }
  const remainingProviderIds = new Set(providerIds);
  const ownerPluginIds = new Set<string>();
  const visitedPluginIds = new Set<string>();
  for (const sourceRoot of resolveQaBundledPluginScanRoots(params.repoRoot)) {
    for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(sourceRoot, entry.name, "openclaw.plugin.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        id?: unknown;
        providers?: unknown;
        cliBackends?: unknown;
      };
      const pluginId = typeof manifest.id === "string" ? manifest.id.trim() : entry.name;
      if (!pluginId || visitedPluginIds.has(pluginId)) {
        continue;
      }
      visitedPluginIds.add(pluginId);
      const ownedIds = new Set(
        [
          pluginId,
          ...(Array.isArray(manifest.providers) ? manifest.providers : []),
          ...(Array.isArray(manifest.cliBackends) ? manifest.cliBackends : []),
        ].filter((ownedId): ownedId is string => typeof ownedId === "string"),
      );
      for (const providerId of providerIds) {
        if (!ownedIds.has(providerId)) {
          continue;
        }
        ownerPluginIds.add(pluginId);
        remainingProviderIds.delete(providerId);
      }
    }
  }
  for (const providerId of remainingProviderIds) {
    const providerConfig = params.providerConfigs?.[providerId];
    if (providerConfig && isQaOpenAiResponsesProviderConfig(providerConfig)) {
      ownerPluginIds.add(QA_OPENAI_PLUGIN_ID);
      continue;
    }
    ownerPluginIds.add(providerId);
  }
  return [...ownerPluginIds];
}

function collectQaBundledPluginIds(params: {
  repoRoot: string;
  allowedPluginIds: readonly string[];
}) {
  const pluginIds = new Set(
    params.allowedPluginIds.map((pluginId) => {
      assertSafeQaBundledPluginId(pluginId);
      return pluginId;
    }),
  );
  for (const pluginId of QA_ALWAYS_STAGE_RUNTIME_PLUGIN_IDS) {
    if (
      resolveQaBundledPluginSourceDir({
        repoRoot: params.repoRoot,
        pluginId,
      })
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds];
}

function resolveQaStagedBundledTreeName(repoRoot: string) {
  if (existsSync(path.join(repoRoot, "dist"))) {
    return "dist";
  }
  if (existsSync(path.join(repoRoot, "dist-runtime"))) {
    return "dist-runtime";
  }
  return "dist";
}

function resolveQaBuiltBundledPluginTreeRoot(params: { repoRoot: string; sourceDir: string }) {
  const sourceDir = path.resolve(params.sourceDir);
  for (const treeName of ["dist", "dist-runtime"] as const) {
    const extensionsRoot = path.join(params.repoRoot, treeName, "extensions");
    const relativeSourceDir = path.relative(extensionsRoot, sourceDir);
    if (
      relativeSourceDir.length > 0 &&
      !relativeSourceDir.startsWith("..") &&
      !path.isAbsolute(relativeSourceDir)
    ) {
      return path.join(params.repoRoot, treeName);
    }
  }
  return null;
}

async function symlinkQaStagedDirEntry(params: {
  sourcePath: string;
  targetPath: string;
  directory?: boolean;
}) {
  await fs.symlink(
    params.sourcePath,
    params.targetPath,
    params.directory ? (process.platform === "win32" ? "junction" : "dir") : "file",
  );
}

async function resolveQaStagedDirEntryDirectory(params: {
  sourcePath: string;
  entry?: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
}) {
  if (params.entry?.isDirectory()) {
    return true;
  }
  if (params.entry?.isSymbolicLink()) {
    return (await fs.stat(params.sourcePath)).isDirectory();
  }
  if (params.entry) {
    return false;
  }
  return (await fs.lstat(params.sourcePath)).isDirectory();
}

async function seedQaStagedNodeModules(params: { repoRoot: string; stagedRoot: string }) {
  const sourceNodeModulesDir = path.join(params.repoRoot, "node_modules");
  if (!existsSync(sourceNodeModulesDir)) {
    return;
  }
  const stagedNodeModulesDir = path.join(params.stagedRoot, "node_modules");
  await fs.mkdir(stagedNodeModulesDir, { recursive: true });
  for (const entry of await fs.readdir(sourceNodeModulesDir, { withFileTypes: true })) {
    if (entry.name === "openclaw") {
      continue;
    }
    await symlinkQaStagedDirEntry({
      sourcePath: path.join(sourceNodeModulesDir, entry.name),
      targetPath: path.join(stagedNodeModulesDir, entry.name),
      directory: await resolveQaStagedDirEntryDirectory({
        sourcePath: path.join(sourceNodeModulesDir, entry.name),
        entry,
      }),
    });
  }
}

function collectQaBuiltTreeRoots(params: {
  repoRoot: string;
  stagedPluginIds: readonly string[];
  stagedTreeName: string;
}) {
  const treeRoots = new Set<string>();
  treeRoots.add(path.join(params.repoRoot, params.stagedTreeName));
  for (const pluginId of params.stagedPluginIds) {
    const sourceDir = resolveQaBundledPluginSourceDir({
      repoRoot: params.repoRoot,
      pluginId,
    });
    if (!sourceDir) {
      continue;
    }
    const builtTreeRoot = resolveQaBuiltBundledPluginTreeRoot({
      repoRoot: params.repoRoot,
      sourceDir,
    });
    if (builtTreeRoot) {
      treeRoots.add(builtTreeRoot);
    }
  }
  return [...treeRoots];
}

async function seedQaStagedBuiltTreeRoots(params: {
  stagedTreeRoot: string;
  sourceTreeRoots: readonly string[];
}) {
  for (const sourceTreeRoot of params.sourceTreeRoots) {
    if (!existsSync(sourceTreeRoot)) {
      continue;
    }
    for (const entry of await fs.readdir(sourceTreeRoot, { withFileTypes: true })) {
      if (entry.name === "extensions") {
        continue;
      }
      const targetPath = path.join(params.stagedTreeRoot, entry.name);
      if (existsSync(targetPath)) {
        continue;
      }
      await symlinkQaStagedDirEntry({
        sourcePath: path.join(sourceTreeRoot, entry.name),
        targetPath,
        directory: await resolveQaStagedDirEntryDirectory({
          sourcePath: path.join(sourceTreeRoot, entry.name),
          entry,
        }),
      });
    }
  }
}

export async function resolveQaRuntimeHostVersion(params: {
  repoRoot: string;
  allowedPluginIds: readonly string[];
}) {
  const rootPackageRaw = await fs.readFile(path.join(params.repoRoot, "package.json"), "utf8");
  const rootPackage = JSON.parse(rootPackageRaw) as { version?: string };
  let selected = parseStableSemverFloor(rootPackage.version);
  const stagedPluginIds = collectQaBundledPluginIds({
    repoRoot: params.repoRoot,
    allowedPluginIds: params.allowedPluginIds,
  });

  for (const pluginId of stagedPluginIds) {
    const sourceDir = resolveQaBundledPluginSourceDir({
      repoRoot: params.repoRoot,
      pluginId,
    });
    if (!sourceDir) {
      continue;
    }
    const packagePath = path.join(sourceDir, "package.json");
    if (!existsSync(packagePath)) {
      continue;
    }
    const packageRaw = await fs.readFile(packagePath, "utf8");
    const packageJson = JSON.parse(packageRaw) as {
      openclaw?: {
        install?: {
          minHostVersion?: string;
        };
      };
    };
    const candidate = parseStableSemverFloor(packageJson.openclaw?.install?.minHostVersion);
    if (compareSemverFloors(candidate, selected) > 0) {
      selected = candidate;
    }
  }

  return selected?.label;
}

export async function createQaBundledPluginsDir(params: {
  repoRoot: string;
  tempRoot: string;
  allowedPluginIds: readonly string[];
}) {
  const stagedPluginIds = collectQaBundledPluginIds({
    repoRoot: params.repoRoot,
    allowedPluginIds: params.allowedPluginIds,
  });
  const stagedRoot = path.join(
    params.repoRoot,
    ".artifacts",
    "qa-runtime",
    path.basename(params.tempRoot),
  );
  await fs.rm(stagedRoot, { recursive: true, force: true });
  await fs.mkdir(stagedRoot, { recursive: true });
  await fs.copyFile(
    path.join(params.repoRoot, "package.json"),
    path.join(stagedRoot, "package.json"),
  );
  await seedQaStagedNodeModules({
    repoRoot: params.repoRoot,
    stagedRoot,
  });
  const stagedOpenClawPackageDir = path.join(stagedRoot, "node_modules", "openclaw");
  await fs.mkdir(stagedOpenClawPackageDir, { recursive: true });
  await fs.copyFile(
    path.join(params.repoRoot, "package.json"),
    path.join(stagedOpenClawPackageDir, "package.json"),
  );
  const stagedTreeName = resolveQaStagedBundledTreeName(params.repoRoot);
  const stagedTreeRoot = path.join(stagedRoot, stagedTreeName);
  await fs.mkdir(stagedTreeRoot, { recursive: true });
  await seedQaStagedBuiltTreeRoots({
    stagedTreeRoot,
    sourceTreeRoots: collectQaBuiltTreeRoots({
      repoRoot: params.repoRoot,
      stagedPluginIds,
      stagedTreeName,
    }),
  });
  if (stagedTreeName === "dist-runtime" && !existsSync(path.join(stagedRoot, "dist"))) {
    const repoDistDir = path.join(params.repoRoot, "dist");
    const stagedDistTarget = existsSync(repoDistDir) ? repoDistDir : stagedTreeRoot;
    await symlinkQaStagedDirEntry({
      sourcePath: stagedDistTarget,
      targetPath: path.join(stagedRoot, "dist"),
      directory: true,
    });
  }
  const bundledPluginsDir = path.join(stagedTreeRoot, "extensions");
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  for (const pluginId of stagedPluginIds) {
    const sourceDir = resolveQaBundledPluginSourceDir({
      repoRoot: params.repoRoot,
      pluginId,
    });
    if (!sourceDir) {
      throw new Error(`qa bundled plugin not found: ${pluginId}`);
    }
    await fs.cp(sourceDir, path.join(bundledPluginsDir, pluginId), { recursive: true });
  }
  await symlinkQaStagedDirEntry({
    sourcePath: path.join(stagedRoot, "dist"),
    targetPath: path.join(stagedOpenClawPackageDir, "dist"),
    directory: true,
  });
  return {
    bundledPluginsDir,
    stagedRoot,
  };
}
