import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeChatChannelId } from "../channels/ids.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizePluginsConfig } from "./config-state.js";
import { satisfies, validRange, validSemver } from "./semver.runtime.js";

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
  installExecutionRoot?: string;
  missingSpecs: string[];
  installSpecs?: string[];
};

export type BundledRuntimeDepsEnsureResult = {
  installedSpecs: string[];
  retainSpecs: string[];
};

export type BundledRuntimeDepsInstallRoot = {
  installRoot: string;
  external: boolean;
};

type JsonObject = Record<string, unknown>;
const RETAINED_RUNTIME_DEPS_MANIFEST = ".openclaw-runtime-deps.json";

export type BundledRuntimeDepsNpmRunner = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

const BUNDLED_RUNTIME_DEP_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

function normalizeInstallableRuntimeDepName(rawName: string): string | null {
  const depName = rawName.trim();
  if (depName === "") {
    return null;
  }
  const segments = depName.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  if (segments.length === 1) {
    return BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(segments[0] ?? "") ? depName : null;
  }
  if (segments.length !== 2 || !segments[0]?.startsWith("@")) {
    return null;
  }
  const scope = segments[0].slice(1);
  const packageName = segments[1];
  return BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(scope) &&
    BUNDLED_RUNTIME_DEP_SEGMENT_RE.test(packageName ?? "")
    ? depName
    : null;
}

function normalizeInstallableRuntimeDepVersion(rawVersion: unknown): string | null {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const version = rawVersion.trim();
  if (version === "" || version.toLowerCase().startsWith("workspace:")) {
    return null;
  }
  if (validSemver(version)) {
    return version;
  }
  const rangePrefix = version[0];
  if ((rangePrefix === "^" || rangePrefix === "~") && validSemver(version.slice(1))) {
    return version;
  }
  return null;
}

function parseInstallableRuntimeDep(
  name: string,
  rawVersion: unknown,
): { name: string; version: string } | null {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const version = rawVersion.trim();
  if (version === "" || version.toLowerCase().startsWith("workspace:")) {
    return null;
  }
  const normalizedName = normalizeInstallableRuntimeDepName(name);
  if (!normalizedName) {
    throw new Error(`Invalid bundled runtime dependency name: ${name}`);
  }
  const normalizedVersion = normalizeInstallableRuntimeDepVersion(version);
  if (!normalizedVersion) {
    throw new Error(
      `Unsupported bundled runtime dependency spec for ${normalizedName}: ${version}`,
    );
  }
  return { name: normalizedName, version: normalizedVersion };
}

function parseInstallableRuntimeDepSpec(spec: string): { name: string; version: string } {
  const atIndex = spec.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === spec.length - 1) {
    throw new Error(`Invalid bundled runtime dependency install spec: ${spec}`);
  }
  const parsed = parseInstallableRuntimeDep(spec.slice(0, atIndex), spec.slice(atIndex + 1));
  if (!parsed) {
    throw new Error(`Invalid bundled runtime dependency install spec: ${spec}`);
  }
  return parsed;
}

function dependencySentinelPath(depName: string): string {
  const normalizedDepName = normalizeInstallableRuntimeDepName(depName);
  if (!normalizedDepName) {
    throw new Error(`Invalid bundled runtime dependency name: ${depName}`);
  }
  return path.join("node_modules", ...normalizedDepName.split("/"), "package.json");
}

function resolveDependencySentinelAbsolutePath(rootDir: string, depName: string): string {
  const nodeModulesDir = path.resolve(rootDir, "node_modules");
  const sentinelPath = path.resolve(rootDir, dependencySentinelPath(depName));
  if (sentinelPath !== nodeModulesDir && !sentinelPath.startsWith(`${nodeModulesDir}${path.sep}`)) {
    throw new Error(`Blocked runtime dependency path escape for ${depName}`);
  }
  return sentinelPath;
}

function readInstalledDependencyVersion(rootDir: string, depName: string): string | null {
  const parsed = readJsonObject(resolveDependencySentinelAbsolutePath(rootDir, depName));
  const version = parsed && typeof parsed.version === "string" ? parsed.version.trim() : "";
  return version || null;
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

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    (fs.existsSync(path.join(packageRoot, ".git")) ||
      fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml"))) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function resolveSourceCheckoutBundledPluginPackageRoot(pluginRoot: string): string | null {
  const extensionsDir = path.dirname(path.resolve(pluginRoot));
  if (path.basename(extensionsDir) !== "extensions") {
    return null;
  }
  const packageRoot = path.dirname(extensionsDir);
  return isSourceCheckoutRoot(packageRoot) ? packageRoot : null;
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

function resolveSourceCheckoutPackageRoot(pluginRoot: string): string | null {
  return (
    resolveSourceCheckoutBundledPluginPackageRoot(pluginRoot) ??
    resolveSourceCheckoutDistPackageRoot(pluginRoot)
  );
}

function resolveBundledPluginPackageRoot(pluginRoot: string): string | null {
  const extensionsDir = path.dirname(path.resolve(pluginRoot));
  const buildDir = path.dirname(extensionsDir);
  if (
    path.basename(extensionsDir) !== "extensions" ||
    (path.basename(buildDir) !== "dist" && path.basename(buildDir) !== "dist-runtime")
  ) {
    return null;
  }
  return path.dirname(buildDir);
}

function createRuntimeDepsCacheKey(pluginId: string, specs: readonly string[]): string {
  return createHash("sha256")
    .update(pluginId)
    .update("\0")
    .update(specs.join("\0"))
    .digest("hex")
    .slice(0, 16);
}

function createPathHash(value: string): string {
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 12);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function readPackageVersion(packageRoot: string): string {
  const parsed = readJsonObject(path.join(packageRoot, "package.json"));
  const version = parsed && typeof parsed.version === "string" ? parsed.version.trim() : "";
  return version || "unknown";
}

function readRetainedRuntimeDepsManifest(installRoot: string): string[] {
  const parsed = readJsonObject(path.join(installRoot, RETAINED_RUNTIME_DEPS_MANIFEST));
  const specs = parsed?.specs;
  if (!Array.isArray(specs)) {
    return [];
  }
  return specs
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .toSorted((left, right) => left.localeCompare(right));
}

function writeRetainedRuntimeDepsManifest(installRoot: string, specs: readonly string[]): void {
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(
    path.join(installRoot, RETAINED_RUNTIME_DEPS_MANIFEST),
    `${JSON.stringify({ specs: [...specs].toSorted((left, right) => left.localeCompare(right)) }, null, 2)}\n`,
    "utf8",
  );
}

function removeRetainedRuntimeDepsManifest(installRoot: string): void {
  fs.rmSync(path.join(installRoot, RETAINED_RUNTIME_DEPS_MANIFEST), { force: true });
}

function shouldPersistRetainedRuntimeDepsManifest(params: {
  pluginRoot: string;
  installRoot: string;
}): boolean {
  if (path.resolve(params.installRoot) !== path.resolve(params.pluginRoot)) {
    return true;
  }
  return !resolveSourceCheckoutPackageRoot(params.pluginRoot);
}

export function isWritableDirectory(dir: string): boolean {
  let probeDir: string | null = null;
  try {
    probeDir = fs.mkdtempSync(path.join(dir, ".openclaw-write-probe-"));
    fs.writeFileSync(path.join(probeDir, "probe"), "", "utf8");
    return true;
  } catch {
    return false;
  } finally {
    if (probeDir) {
      try {
        fs.rmSync(probeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup. A failed cleanup should not turn a writable
        // probe into a hard runtime-dependency failure.
      }
    }
  }
}

function resolveSystemdStateDirectory(env: NodeJS.ProcessEnv): string | null {
  const raw = env.STATE_DIRECTORY?.trim();
  if (!raw) {
    return null;
  }
  const first = raw.split(path.delimiter).find((entry) => entry.trim().length > 0);
  return first ? path.resolve(first) : null;
}

function resolveBundledRuntimeDepsExternalBaseDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_PLUGIN_STAGE_DIR?.trim();
  if (explicit) {
    return resolveHomeRelativePath(explicit, { env, homedir: os.homedir });
  }
  const systemdStateDir = resolveSystemdStateDirectory(env);
  if (systemdStateDir) {
    return path.join(systemdStateDir, "plugin-runtime-deps");
  }
  return path.join(resolveStateDir(env, os.homedir), "plugin-runtime-deps");
}

function resolveExternalBundledRuntimeDepsInstallRoot(params: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}): string {
  const packageRoot = resolveBundledPluginPackageRoot(params.pluginRoot) ?? params.pluginRoot;
  const version = sanitizePathSegment(readPackageVersion(packageRoot));
  const packageKey = `openclaw-${version}-${createPathHash(packageRoot)}`;
  return path.join(resolveBundledRuntimeDepsExternalBaseDir(params.env), packageKey);
}

function resolveSourceCheckoutRuntimeDepsCacheDir(params: {
  pluginId: string;
  pluginRoot: string;
  installSpecs: readonly string[];
}): string | null {
  const packageRoot = resolveSourceCheckoutPackageRoot(params.pluginRoot);
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

function isInstalledDependencyVersionSatisfied(installedVersion: string, spec: string): boolean {
  const normalizedInstalledVersion = validSemver(installedVersion);
  const normalizedRange = validRange(spec);
  if (normalizedInstalledVersion && normalizedRange) {
    return satisfies(normalizedInstalledVersion, normalizedRange, {
      includePrerelease: true,
    });
  }
  return installedVersion === spec;
}

function hasDependencySentinel(
  searchRoots: readonly string[],
  dep: { name: string; version: string },
): boolean {
  return searchRoots.some((rootDir) => {
    const installedVersion = readInstalledDependencyVersion(rootDir, dep.name);
    return (
      typeof installedVersion === "string" &&
      isInstalledDependencyVersionSatisfied(installedVersion, dep.version)
    );
  });
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
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Stale temp dirs are swept at the next runtime-deps pass. Do not fail
      // a node_modules replacement on a transient cleanup race.
    }
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
  missingSpecs.forEach((spec) => {
    parseInstallableRuntimeDepSpec(spec);
  });
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
    throw new Error("Unable to resolve a safe npm executable on Windows");
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
  includeConfiguredChannels?: boolean;
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
      (params.includeConfiguredChannels ||
        (channelConfig as { enabled?: unknown }).enabled === true)
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
  includeConfiguredChannels?: boolean;
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
    includeConfiguredChannels: params.includeConfiguredChannels,
  });
}

function collectBundledPluginRuntimeDeps(params: {
  extensionsDir: string;
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  includeConfiguredChannels?: boolean;
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
        includeConfiguredChannels: params.includeConfiguredChannels,
      })
    ) {
      continue;
    }
    const packageJson = readJsonObject(path.join(pluginDir, "package.json"));
    if (!packageJson) {
      continue;
    }
    for (const [name, rawVersion] of Object.entries(collectRuntimeDeps(packageJson))) {
      const dep = parseInstallableRuntimeDep(name, rawVersion);
      if (!dep) {
        continue;
      }
      const byVersion = versionMap.get(dep.name) ?? new Map<string, Set<string>>();
      const pluginIds = byVersion.get(dep.version) ?? new Set<string>();
      pluginIds.add(pluginId);
      byVersion.set(dep.version, pluginIds);
      versionMap.set(dep.name, byVersion);
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
  includeConfiguredChannels?: boolean;
  env?: NodeJS.ProcessEnv;
}): {
  deps: RuntimeDepEntry[];
  missing: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
} {
  if (isSourceCheckoutRoot(params.packageRoot)) {
    return { deps: [], missing: [], conflicts: [] };
  }
  const extensionsDir = path.join(params.packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return { deps: [], missing: [], conflicts: [] };
  }
  const { deps, conflicts } = collectBundledPluginRuntimeDeps({
    extensionsDir,
    config: params.config,
    pluginIds: normalizePluginIdSet(params.pluginIds),
    includeConfiguredChannels: params.includeConfiguredChannels,
  });
  const packageInstallRoot = resolveBundledRuntimeDependencyPackageInstallRoot(params.packageRoot, {
    env: params.env,
  });
  const packageSearchRoots = [packageInstallRoot];
  const missing = deps.filter(
    (dep) =>
      !hasDependencySentinel(packageSearchRoots, dep) &&
      dep.pluginIds.every((pluginId) => {
        const pluginRoot = path.join(extensionsDir, pluginId);
        const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, {
          env: params.env,
        });
        return !hasDependencySentinel([installRoot], dep);
      }),
  );
  return { deps, missing, conflicts };
}

export function resolveBundledRuntimeDependencyPackageInstallRoot(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  const env = options.env ?? process.env;
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim()
  ) {
    return resolveExternalBundledRuntimeDepsInstallRoot({
      pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
      env,
    });
  }
  return isWritableDirectory(packageRoot)
    ? packageRoot
    : resolveExternalBundledRuntimeDepsInstallRoot({
        pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
        env,
      });
}

export function resolveBundledRuntimeDependencyInstallRoot(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  const env = options.env ?? process.env;
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim()
  ) {
    return resolveExternalBundledRuntimeDepsInstallRoot({ pluginRoot, env });
  }
  return isWritableDirectory(pluginRoot)
    ? pluginRoot
    : resolveExternalBundledRuntimeDepsInstallRoot({ pluginRoot, env });
}

export function resolveBundledRuntimeDependencyInstallRootInfo(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRoot {
  const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, options);
  return {
    installRoot,
    external: path.resolve(installRoot) !== path.resolve(pluginRoot),
  };
}

export function createBundledRuntimeDependencyAliasMap(params: {
  pluginRoot: string;
  installRoot: string;
}): Record<string, string> {
  if (path.resolve(params.installRoot) === path.resolve(params.pluginRoot)) {
    return {};
  }
  const packageJson = readJsonObject(path.join(params.pluginRoot, "package.json"));
  if (!packageJson) {
    return {};
  }
  const aliases: Record<string, string> = {};
  for (const name of Object.keys(collectRuntimeDeps(packageJson)).toSorted((a, b) =>
    a.localeCompare(b),
  )) {
    const normalizedName = normalizeInstallableRuntimeDepName(name);
    if (!normalizedName) {
      continue;
    }
    const target = path.join(params.installRoot, "node_modules", ...normalizedName.split("/"));
    if (fs.existsSync(path.join(target, "package.json"))) {
      aliases[normalizedName] = target;
    }
  }
  return aliases;
}

export function installBundledRuntimeDeps(params: {
  installRoot: string;
  installExecutionRoot?: string;
  missingSpecs: string[];
  env: NodeJS.ProcessEnv;
}): void {
  const installExecutionRoot = params.installExecutionRoot ?? params.installRoot;
  fs.mkdirSync(params.installRoot, { recursive: true });
  fs.mkdirSync(installExecutionRoot, { recursive: true });
  if (path.resolve(installExecutionRoot) !== path.resolve(params.installRoot)) {
    fs.writeFileSync(
      path.join(installExecutionRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw-runtime-deps-install", private: true }, null, 2)}\n`,
      "utf8",
    );
  }
  const installEnv = createBundledRuntimeDepsInstallEnv(params.env);
  const npmRunner = resolveBundledRuntimeDepsNpmRunner({
    env: installEnv,
    npmArgs: createBundledRuntimeDepsInstallArgs(params.missingSpecs),
  });
  const result = spawnSync(npmRunner.command, npmRunner.args, {
    cwd: installExecutionRoot,
    encoding: "utf8",
    env: npmRunner.env ?? installEnv,
    stdio: "pipe",
  });
  if (result.status !== 0 || result.error) {
    const output = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(output || "npm install failed");
  }
  if (path.resolve(installExecutionRoot) !== path.resolve(params.installRoot)) {
    const stagedNodeModulesDir = path.join(installExecutionRoot, "node_modules");
    if (!fs.existsSync(stagedNodeModulesDir)) {
      throw new Error("npm install did not produce node_modules");
    }
    replaceNodeModulesDir(path.join(params.installRoot, "node_modules"), stagedNodeModulesDir);
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
    .map(([name, rawVersion]) => parseInstallableRuntimeDep(name, rawVersion))
    .filter((entry): entry is { name: string; version: string } => Boolean(entry));
  if (deps.length === 0) {
    return { installedSpecs: [], retainSpecs: [] };
  }

  const installRoot = resolveBundledRuntimeDependencyInstallRoot(params.pluginRoot, {
    env: params.env,
  });
  const persistRetainedManifest = shouldPersistRetainedRuntimeDepsManifest({
    pluginRoot: params.pluginRoot,
    installRoot,
  });
  if (!persistRetainedManifest) {
    removeRetainedRuntimeDepsManifest(installRoot);
  }
  const dependencySpecs = deps
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
  const missingSpecs = deps
    .filter((dep) => !hasDependencySentinel([installRoot], dep))
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
  if (missingSpecs.length === 0) {
    return { installedSpecs: [], retainSpecs: [] };
  }
  const retainedManifestSpecs = persistRetainedManifest
    ? readRetainedRuntimeDepsManifest(installRoot)
    : [];
  const installSpecs = [
    ...new Set([...(params.retainSpecs ?? []), ...retainedManifestSpecs, ...dependencySpecs]),
  ].toSorted((left, right) => left.localeCompare(right));
  const cacheDir = resolveSourceCheckoutRuntimeDepsCacheDir({
    pluginId: params.pluginId,
    pluginRoot: params.pluginRoot,
    installSpecs,
  });
  const installExecutionRoot =
    cacheDir &&
    path.resolve(installRoot) === path.resolve(params.pluginRoot) &&
    resolveSourceCheckoutBundledPluginPackageRoot(params.pluginRoot)
      ? cacheDir
      : undefined;
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
        installExecutionRoot: installParams.installExecutionRoot,
        missingSpecs: installParams.installSpecs ?? installParams.missingSpecs,
        env: params.env,
      }));
  install({ installRoot, installExecutionRoot, missingSpecs, installSpecs });
  if (persistRetainedManifest) {
    writeRetainedRuntimeDepsManifest(installRoot, installSpecs);
  }
  storeSourceCheckoutRuntimeDepsCache({ cacheDir, installRoot });
  return { installedSpecs: missingSpecs, retainSpecs: installSpecs };
}
