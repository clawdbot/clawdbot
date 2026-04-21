import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizePluginsConfig } from "./config-state.js";

export type RuntimeDepEntry = {
  name: string;
  version: string;
  pluginIds: string[];
};

export type RuntimeDepConflict = {
  name: string;
  versions: string[];
  pluginIdsByVersion: Map<string, string[]>;
};

export type BundledRuntimeDepsInstallParams = {
  installRoot: string;
  missingSpecs: string[];
  installSpecs?: string[];
};

export type BundledRuntimeDepsEnsureResult = {
  installedSpecs: string[];
  retainSpecs: string[];
};

type JsonObject = Record<string, unknown>;

export type BundledRuntimeDepsNpmRunner = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

function dependencySentinelPath(depName: string): string {
  return path.join("node_modules", ...depName.split("/"), "package.json");
}

function readJsonObject(filePath: string): JsonObject | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function collectRuntimeDeps(packageJson: JsonObject): Record<string, unknown> {
  return {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.optionalDependencies as Record<string, unknown> | undefined),
  };
}

function normalizeInstallableRuntimeDepVersion(rawVersion: unknown): string | null {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const version = rawVersion.trim();
  if (version === "" || version.toLowerCase().startsWith("workspace:")) {
    return null;
  }
  return version;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function isSourceCheckoutBundledPluginRoot(pluginRoot: string): boolean {
  const extensionsDir = path.dirname(pluginRoot);
  if (path.basename(extensionsDir) !== "extensions") {
    return false;
  }
  return isSourceCheckoutRoot(path.dirname(extensionsDir));
}

function resolveSourceCheckoutDistPackageRoot(pluginRoot: string): string | null {
  const extensionsDir = path.dirname(pluginRoot);
  const buildDir = path.dirname(extensionsDir);
  if (
    path.basename(extensionsDir) !== "extensions" ||
    (path.basename(buildDir) !== "dist" && path.basename(buildDir) !== "dist-runtime")
  ) {
    return null;
  }
  const packageRoot = path.dirname(buildDir);
  return isSourceCheckoutRoot(packageRoot) ? packageRoot : null;
}

function resolveBundledRuntimeDependencySearchRoots(params: {
  installRoot: string;
  pluginRoot: string;
}): string[] {
  const roots = new Set<string>([params.installRoot]);
  const pluginRoot = path.resolve(params.pluginRoot);
  const extensionsDir = path.dirname(pluginRoot);
  const buildDir = path.dirname(extensionsDir);
  if (
    path.basename(extensionsDir) !== "extensions" ||
    (path.basename(buildDir) !== "dist" && path.basename(buildDir) !== "dist-runtime")
  ) {
    return [...roots];
  }
  roots.add(extensionsDir);
  roots.add(buildDir);
  roots.add(path.dirname(buildDir));
  return [...roots];
}

function createRuntimeDepsCacheKey(pluginId: string, specs: readonly string[]): string {
  return createHash("sha256")
    .update(pluginId)
    .update("\0")
    .update(specs.join("\0"))
    .digest("hex")
    .slice(0, 16);
}

function resolveSourceCheckoutRuntimeDepsCacheDir(params: {
  pluginId: string;
  pluginRoot: string;
  installSpecs: readonly string[];
}): string | null {
  const packageRoot = resolveSourceCheckoutDistPackageRoot(params.pluginRoot);
  if (!packageRoot) {
    return null;
  }
  return path.join(
    packageRoot,
    ".local",
    "bundled-plugin-runtime-deps",
    `${params.pluginId}-${createRuntimeDepsCacheKey(params.pluginId, params.installSpecs)}`,
  );
}

function hasAllDependencySentinels(rootDir: string, deps: readonly { name: string }[]): boolean {
  return deps.every((dep) => fs.existsSync(path.join(rootDir, dependencySentinelPath(dep.name))));
}

function hasDependencySentinel(searchRoots: readonly string[], dep: { name: string }): boolean {
  return searchRoots.some((rootDir) =>
    fs.existsSync(path.join(rootDir, dependencySentinelPath(dep.name))),
  );
}

function replaceNodeModulesDir(targetDir: string, sourceDir: string): void {
  const parentDir = path.dirname(targetDir);
  const tempDir = fs.mkdtempSync(path.join(parentDir, ".openclaw-runtime-deps-copy-"));
  const stagedDir = path.join(tempDir, "node_modules");
  try {
    fs.cpSync(sourceDir, stagedDir, { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagedDir, targetDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function restoreSourceCheckoutRuntimeDepsFromCache(params: {
  cacheDir: string | null;
  deps: readonly { name: string }[];
  installRoot: string;
}): boolean {
  if (!params.cacheDir) {
    return false;
  }
  const cachedNodeModulesDir = path.join(params.cacheDir, "node_modules");
  if (!hasAllDependencySentinels(params.cacheDir, params.deps)) {
    return false;
  }
  try {
    replaceNodeModulesDir(path.join(params.installRoot, "node_modules"), cachedNodeModulesDir);
    return true;
  } catch {
    return false;
  }
}

function storeSourceCheckoutRuntimeDepsCache(params: {
  cacheDir: string | null;
  installRoot: string;
}): void {
  if (!params.cacheDir) {
    return;
  }
  const nodeModulesDir = path.join(params.installRoot, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    return;
  }
  let tempDir: string | null = null;
  try {
    fs.mkdirSync(path.dirname(params.cacheDir), { recursive: true });
    tempDir = fs.mkdtempSync(path.join(path.dirname(params.cacheDir), ".runtime-deps-cache-"));
    fs.cpSync(nodeModulesDir, path.join(tempDir, "node_modules"), { recursive: true });
    fs.rmSync(params.cacheDir, { recursive: true, force: true });
    fs.renameSync(tempDir, params.cacheDir);
  } catch {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function createNestedNpmInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_location;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
}

export function createBundledRuntimeDepsInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...createNestedNpmInstallEnv(env),
    npm_config_legacy_peer_deps: "true",
    npm_config_package_lock: "false",
    npm_config_save: "false",
  };
}

export function createBundledRuntimeDepsInstallArgs(missingSpecs: readonly string[]): string[] {
  return ["install", "--ignore-scripts", ...missingSpecs];
}

function resolvePathEnvKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return "PATH";
  }
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function isNpmCliPath(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith("/npm-cli.js") || normalized.endsWith("/npm/bin/npm-cli.js");
}

export function resolveBundledRuntimeDepsNpmRunner(params: {
  npmArgs: string[];
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: typeof fs.existsSync;
  platform?: NodeJS.Platform;
}): BundledRuntimeDepsNpmRunner {
  const env = params.env ?? process.env;
  const execPath = params.execPath ?? process.execPath;
  const existsSync = params.existsSync ?? fs.existsSync;
  const platform = params.platform ?? process.platform;
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const nodeDir = pathImpl.dirname(execPath);
  const rawNpmExecPath = normalizeOptionalLowercaseString(env.npm_execpath)
    ? env.npm_execpath
    : undefined;
  const npmExecPath = rawNpmExecPath && isNpmCliPath(rawNpmExecPath) ? rawNpmExecPath : undefined;

  const npmCliCandidates = [
    npmExecPath,
    pathImpl.resolve(nodeDir, "../lib/node_modules/npm/bin/npm-cli.js"),
    pathImpl.resolve(nodeDir, "node_modules/npm/bin/npm-cli.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const npmCliPath = npmCliCandidates.find(
    (candidate) => pathImpl.isAbsolute(candidate) && existsSync(candidate),
  );
  if (npmCliPath) {
    return {
      command: execPath,
      args: [npmCliPath, ...params.npmArgs],
    };
  }

  if (platform === "win32") {
    const npmExePath = pathImpl.resolve(nodeDir, "npm.exe");
    if (existsSync(npmExePath)) {
      return {
        command: npmExePath,
        args: params.npmArgs,
      };
    }
    return {
      command: "npm.cmd",
      args: params.npmArgs,
      shell: true,
    };
  }

  const pathKey = resolvePathEnvKey(env, platform);
  const currentPath = env[pathKey];
  return {
    command: "npm",
    args: params.npmArgs,
    env: {
      ...env,
      [pathKey]:
        typeof currentPath === "string" && currentPath.length > 0
          ? `${nodeDir}${path.delimiter}${currentPath}`
          : nodeDir,
    },
  };
}
function readBundledPluginChannels(pluginDir: string): string[] {
  const manifest = readJsonObject(path.join(pluginDir, "openclaw.plugin.json"));
  const channels = manifest?.channels;
  if (!Array.isArray(channels)) {
    return [];
  }
  return channels.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function readBundledPluginEnabledByDefault(pluginDir: string): boolean {
  return readJsonObject(path.join(pluginDir, "openclaw.plugin.json"))?.enabledByDefault === true;
}

function isBundledPluginConfiguredForRuntimeDeps(params: {
  config: OpenClawConfig;
  pluginId: string;
  pluginDir: string;
}): boolean {
  const plugins = normalizePluginsConfig(params.config.plugins);
  if (!plugins.enabled) {
    return false;
  }
  if (plugins.deny.includes(params.pluginId)) {
    return false;
  }
  const entry = plugins.entries[params.pluginId];
  if (entry?.enabled === false) {
    return false;
  }
  if (entry?.enabled === true) {
    return true;
  }
  for (const channelId of readBundledPluginChannels(params.pluginDir)) {
    const normalizedChannelId = normalizeChatChannelId(channelId);
    if (!normalizedChannelId) {
      continue;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === true
    ) {
      return true;
    }
  }
  return readBundledPluginEnabledByDefault(params.pluginDir);
}

function shouldIncludeBundledPluginRuntimeDeps(params: {
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  pluginId: string;
  pluginDir: string;
}): boolean {
  if (params.pluginIds && !params.pluginIds.has(params.pluginId)) {
    return false;
  }
  if (!params.config) {
    return true;
  }
  return isBundledPluginConfiguredForRuntimeDeps({
    config: params.config,
    pluginId: params.pluginId,
    pluginDir: params.pluginDir,
  });
}

function collectBundledPluginRuntimeDeps(params: {
  extensionsDir: string;
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
}): {
  deps: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  const versionMap = new Map<string, Map<string, Set<string>>>();

  for (const entry of fs.readdirSync(params.extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const pluginDir = path.join(params.extensionsDir, pluginId);
    if (
      !shouldIncludeBundledPluginRuntimeDeps({
        config: params.config,
        pluginIds: params.pluginIds,
        pluginId,
        pluginDir,
      })
    ) {
      continue;
    }
    const packageJson = readJsonObject(path.join(pluginDir, "package.json"));
    if (!packageJson) {
      continue;
    }
    for (const [name, rawVersion] of Object.entries(collectRuntimeDeps(packageJson))) {
      const version = normalizeInstallableRuntimeDepVersion(rawVersion);
      if (!version) {
        continue;
      }
      const byVersion = versionMap.get(name) ?? new Map<string, Set<string>>();
      const pluginIds = byVersion.get(version) ?? new Set<string>();
      pluginIds.add(pluginId);
      byVersion.set(version, pluginIds);
      versionMap.set(name, byVersion);
    }
  }

  const deps: RuntimeDepEntry[] = [];
  const conflicts: RuntimeDepConflict[] = [];
  for (const [name, byVersion] of versionMap.entries()) {
    if (byVersion.size === 1) {
      const [version, pluginIds] = [...byVersion.entries()][0] ?? [];
      if (version) {
        deps.push({
          name,
          version,
          pluginIds: [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
        });
      }
      continue;
    }
    const versions = [...byVersion.keys()].toSorted((a, b) => a.localeCompare(b));
    const pluginIdsByVersion = new Map<string, string[]>();
    for (const [version, pluginIds] of byVersion.entries()) {
      pluginIdsByVersion.set(
        version,
        [...pluginIds].toSorted((a, b) => a.localeCompare(b)),
      );
    }
    conflicts.push({
      name,
      versions,
      pluginIdsByVersion,
    });
  }

  return {
    deps: deps.toSorted((a, b) => a.name.localeCompare(b.name)),
    conflicts: conflicts.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

function normalizePluginIdSet(
  pluginIds: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (!pluginIds) {
    return undefined;
  }
  const normalized = pluginIds
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return new Set(normalized);
}

export function scanBundledPluginRuntimeDeps(params: {
  packageRoot: string;
  config?: OpenClawConfig;
  pluginIds?: readonly string[];
}): {
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  if (isSourceCheckoutRoot(params.packageRoot)) {
    return { missing: [], conflicts: [] };
  }
  const extensionsDir = path.join(params.packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return { missing: [], conflicts: [] };
  }
  const { deps, conflicts } = collectBundledPluginRuntimeDeps({
    extensionsDir,
    config: params.config,
    pluginIds: normalizePluginIdSet(params.pluginIds),
  });
  const missing = deps.filter(
    (dep) =>
      !fs.existsSync(path.join(params.packageRoot, dependencySentinelPath(dep.name))) &&
      !fs.existsSync(path.join(extensionsDir, dependencySentinelPath(dep.name))) &&
      dep.pluginIds.every(
        (pluginId) =>
          !fs.existsSync(path.join(extensionsDir, pluginId, dependencySentinelPath(dep.name))),
      ),
  );
  return { missing, conflicts };
}

export function resolveBundledRuntimeDependencyInstallRoot(pluginRoot: string): string {
  return pluginRoot;
}

export function installBundledRuntimeDeps(params: {
  installRoot: string;
  missingSpecs: string[];
  env: NodeJS.ProcessEnv;
}): void {
  const installEnv = createBundledRuntimeDepsInstallEnv(params.env);
  const npmRunner = resolveBundledRuntimeDepsNpmRunner({
    env: installEnv,
    npmArgs: createBundledRuntimeDepsInstallArgs(params.missingSpecs),
  });
  const result = spawnSync(npmRunner.command, npmRunner.args, {
    cwd: params.installRoot,
    encoding: "utf8",
    env: npmRunner.env ?? installEnv,
    stdio: "pipe",
    shell: npmRunner.shell ?? false,
  });
  if (result.status !== 0 || result.error) {
    const output = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(output || "npm install failed");
  }
}

export function ensureBundledPluginRuntimeDeps(params: {
  pluginId: string;
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  retainSpecs?: readonly string[];
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): BundledRuntimeDepsEnsureResult {
  if (isSourceCheckoutBundledPluginRoot(params.pluginRoot)) {
    return { installedSpecs: [], retainSpecs: [] };
  }
  if (
    params.config &&
    !isBundledPluginConfiguredForRuntimeDeps({
      config: params.config,
      pluginId: params.pluginId,
      pluginDir: params.pluginRoot,
    })
  ) {
    return { installedSpecs: [], retainSpecs: [] };
  }
  const packageJson = readJsonObject(path.join(params.pluginRoot, "package.json"));
  if (!packageJson) {
    return { installedSpecs: [], retainSpecs: [] };
  }
  const deps = Object.entries(collectRuntimeDeps(packageJson))
    .map(([name, rawVersion]) => {
      const version = normalizeInstallableRuntimeDepVersion(rawVersion);
      return version ? { name, version } : null;
    })
    .filter((entry): entry is { name: string; version: string } => Boolean(entry));
  if (deps.length === 0) {
    return { installedSpecs: [], retainSpecs: [] };
  }

  const installRoot = resolveBundledRuntimeDependencyInstallRoot(params.pluginRoot);
  const dependencySearchRoots = resolveBundledRuntimeDependencySearchRoots({
    installRoot,
    pluginRoot: params.pluginRoot,
  });
  const dependencySpecs = deps
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
  const missingSpecs = deps
    .filter((dep) => !hasDependencySentinel(dependencySearchRoots, dep))
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
  if (missingSpecs.length === 0) {
    return { installedSpecs: [], retainSpecs: [] };
  }
  const installSpecs = [...new Set([...(params.retainSpecs ?? []), ...dependencySpecs])].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const cacheDir = resolveSourceCheckoutRuntimeDepsCacheDir({
    pluginId: params.pluginId,
    pluginRoot: params.pluginRoot,
    installSpecs,
  });
  if (
    restoreSourceCheckoutRuntimeDepsFromCache({
      cacheDir,
      deps,
      installRoot,
    })
  ) {
    return { installedSpecs: [], retainSpecs: [] };
  }

  const install =
    params.installDeps ??
    ((installParams) =>
      installBundledRuntimeDeps({
        installRoot: installParams.installRoot,
        missingSpecs: installParams.installSpecs ?? installParams.missingSpecs,
        env: params.env,
      }));
  install({ installRoot, missingSpecs, installSpecs });
  storeSourceCheckoutRuntimeDepsCache({ cacheDir, installRoot });
  return { installedSpecs: missingSpecs, retainSpecs: installSpecs };
}
