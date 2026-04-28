import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Module } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLowDiskSpaceWarning } from "../infra/disk-space.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { createNpmProjectInstallEnv } from "../infra/npm-install-env.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { beginBundledRuntimeDepsInstall } from "./bundled-runtime-deps-activity.js";
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
  linkNodeModulesFromExecutionRoot?: boolean;
  missingSpecs: string[];
  installSpecs?: string[];
  warn?: (message: string) => void;
};

export type BundledRuntimeDepsEnsureResult = {
  installedSpecs: string[];
  retainSpecs: string[];
};

export type BundledRuntimeDepsInstallRoot = {
  installRoot: string;
  external: boolean;
};

export type BundledRuntimeDepsInstallRootPlan = BundledRuntimeDepsInstallRoot & {
  searchRoots: string[];
};

type JsonObject = Record<string, unknown>;
const RETAINED_RUNTIME_DEPS_MANIFEST = ".openclaw-runtime-deps.json";
// Packaged bundled plugins (Docker image, npm global install) keep their
// `package.json` next to their entry point; running `npm install <specs>` with
// `cwd: pluginRoot` would make npm resolve the plugin's own `workspace:*`
// dependencies and fail with `EUNSUPPORTEDPROTOCOL`. To avoid that, stage the
// install inside this sub-directory and move the produced `node_modules/` back
// to the plugin root. Source-checkout installs already have their own cache
// path and keep using it.
const PLUGIN_ROOT_INSTALL_STAGE_DIR = ".openclaw-install-stage";
const BUNDLED_RUNTIME_DEPS_LOCK_DIR = ".openclaw-runtime-deps.lock";
const BUNDLED_RUNTIME_DEPS_LOCK_OWNER_FILE = "owner.json";
const BUNDLED_RUNTIME_DEPS_LOCK_WAIT_MS = 100;
const BUNDLED_RUNTIME_DEPS_LOCK_TIMEOUT_MS = 5 * 60_000;
const BUNDLED_RUNTIME_DEPS_LOCK_STALE_MS = 10 * 60_000;
const BUNDLED_RUNTIME_DEPS_OWNERLESS_LOCK_STALE_MS = 30_000;
const BUNDLED_RUNTIME_DEPS_INSTALL_PROGRESS_INTERVAL_MS = 5_000;
const BUNDLED_RUNTIME_MIRROR_MATERIALIZED_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const BUNDLED_EXTENSION_DIST_DIR = "extensions";
const MIRRORED_CORE_RUNTIME_DEP_NAMES = ["semver", "tslog"] as const;
const MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID = "openclaw-core";
const BUNDLED_RUNTIME_MIRROR_PLUGIN_REGION_RE = /(?:^|\n)\/\/#region extensions\/[^/\s]+(?:\/|$)/u;
const BUNDLED_RUNTIME_MIRROR_IMPORT_SPECIFIER_RE =
  /(?:^|[;\n])\s*(?:import|export)\s+(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

const registeredBundledRuntimeDepNodePaths = new Set<string>();

export type BundledRuntimeDepsNpmRunner = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export function shouldMaterializeBundledRuntimeMirrorDistFile(sourcePath: string): boolean {
  if (!BUNDLED_RUNTIME_MIRROR_MATERIALIZED_EXTENSIONS.has(path.extname(sourcePath))) {
    return false;
  }
  let source: string;
  try {
    source = fs.readFileSync(sourcePath, "utf8");
  } catch {
    return false;
  }
  if (BUNDLED_RUNTIME_MIRROR_PLUGIN_REGION_RE.test(source)) {
    return true;
  }
  for (const match of source.matchAll(BUNDLED_RUNTIME_MIRROR_IMPORT_SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? "";
    if (
      specifier !== "" &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("/") &&
      !specifier.startsWith("node:") &&
      !specifier.includes(":")
    ) {
      return false;
    }
  }
  return true;
}

export function materializeBundledRuntimeMirrorDistFile(
  sourcePath: string,
  targetPath: string,
): void {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return;
  }
  try {
    if (
      fs.realpathSync(sourcePath) === fs.realpathSync(targetPath) &&
      !fs.lstatSync(targetPath).isSymbolicLink()
    ) {
      return;
    }
  } catch {
    // Missing targets are expected before the mirror file is materialized.
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  fs.rmSync(targetPath, { recursive: true, force: true });
  try {
    fs.linkSync(sourcePath, targetPath);
    return;
  } catch {
    fs.copyFileSync(sourcePath, targetPath);
  }
  try {
    const sourceMode = fs.statSync(sourcePath).mode;
    fs.chmodSync(targetPath, sourceMode | 0o600);
  } catch {
    // Readable materialized chunks are enough for ESM loading.
  }
}

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type RuntimeDepsLockOwner = {
  pid?: number;
  createdAtMs?: number;
  ownerFileState: "ok" | "missing" | "invalid";
  ownerFilePath: string;
  ownerFileMtimeMs?: number;
  ownerFileIsSymlink?: boolean;
  lockDirMtimeMs?: number;
};

function readRuntimeDepsLockOwner(lockDir: string): RuntimeDepsLockOwner {
  const ownerFilePath = path.join(lockDir, BUNDLED_RUNTIME_DEPS_LOCK_OWNER_FILE);
  let owner: JsonObject | null = null;
  let ownerFileState: RuntimeDepsLockOwner["ownerFileState"] = "missing";
  let ownerFileMtimeMs: number | undefined;
  let ownerFileIsSymlink: boolean | undefined;
  try {
    const ownerFileStat = fs.lstatSync(ownerFilePath);
    ownerFileMtimeMs = ownerFileStat.mtimeMs;
    ownerFileIsSymlink = ownerFileStat.isSymbolicLink();
  } catch {
    // The owner file may not exist yet, or may have been removed by the lock owner.
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFilePath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      owner = parsed as JsonObject;
      ownerFileState = "ok";
    } else {
      ownerFileState = "invalid";
    }
  } catch (error) {
    ownerFileState =
      (error as NodeJS.ErrnoException).code === "ENOENT" && ownerFileMtimeMs === undefined
        ? "missing"
        : "invalid";
  }
  let lockDirMtimeMs: number | undefined;
  try {
    lockDirMtimeMs = fs.statSync(lockDir).mtimeMs;
  } catch {
    // The lock may have disappeared between the mkdir failure and diagnostics.
  }
  return {
    pid: typeof owner?.pid === "number" ? owner.pid : undefined,
    createdAtMs: typeof owner?.createdAtMs === "number" ? owner.createdAtMs : undefined,
    ownerFileState,
    ownerFilePath,
    ownerFileMtimeMs,
    ownerFileIsSymlink,
    lockDirMtimeMs,
  };
}

function latestFiniteMs(values: readonly (number | undefined)[]): number | undefined {
  let latest: number | undefined;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    if (latest === undefined || value > latest) {
      latest = value;
    }
  }
  return latest;
}

function shouldRemoveRuntimeDepsLock(
  owner: Pick<RuntimeDepsLockOwner, "pid" | "createdAtMs" | "lockDirMtimeMs" | "ownerFileMtimeMs">,
  nowMs: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  if (typeof owner.pid === "number") {
    return !isAlive(owner.pid);
  }

  if (typeof owner.createdAtMs === "number") {
    return nowMs - owner.createdAtMs > BUNDLED_RUNTIME_DEPS_LOCK_STALE_MS;
  }

  const ownerlessObservedAtMs = latestFiniteMs([owner.lockDirMtimeMs, owner.ownerFileMtimeMs]);
  return (
    typeof ownerlessObservedAtMs === "number" &&
    nowMs - ownerlessObservedAtMs > BUNDLED_RUNTIME_DEPS_OWNERLESS_LOCK_STALE_MS
  );
}

function formatDurationMs(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? `${Math.max(0, Math.round(ms))}ms` : "n/a";
}

function formatRuntimeDepsLockTimeoutMessage(params: {
  lockDir: string;
  owner: RuntimeDepsLockOwner;
  waitedMs: number;
  nowMs: number;
}): string {
  const ownerAgeMs =
    typeof params.owner.createdAtMs === "number"
      ? params.nowMs - params.owner.createdAtMs
      : undefined;
  const lockAgeMs =
    typeof params.owner.lockDirMtimeMs === "number"
      ? params.nowMs - params.owner.lockDirMtimeMs
      : undefined;
  const ownerFileAgeMs =
    typeof params.owner.ownerFileMtimeMs === "number"
      ? params.nowMs - params.owner.ownerFileMtimeMs
      : undefined;
  const pidDetail =
    typeof params.owner.pid === "number"
      ? `pid=${params.owner.pid} alive=${isProcessAlive(params.owner.pid)}`
      : "pid=missing";
  const ownerFileSymlink =
    typeof params.owner.ownerFileIsSymlink === "boolean" ? params.owner.ownerFileIsSymlink : "n/a";
  return (
    `Timed out waiting for bundled runtime deps lock at ${params.lockDir} ` +
    `(waited=${formatDurationMs(params.waitedMs)}, ownerFile=${params.owner.ownerFileState}, ownerFileSymlink=${ownerFileSymlink}, ` +
    `${pidDetail}, ownerAge=${formatDurationMs(ownerAgeMs)}, ownerFileAge=${formatDurationMs(ownerFileAgeMs)}, lockAge=${formatDurationMs(lockAgeMs)}, ` +
    `ownerFilePath=${params.owner.ownerFilePath}). If no OpenClaw/npm install is running, remove the lock directory and retry.`
  );
}

export const __testing = {
  formatRuntimeDepsLockTimeoutMessage,
  shouldRemoveRuntimeDepsLock,
};

function removeRuntimeDepsLockIfStale(lockDir: string, nowMs: number): boolean {
  const owner = readRuntimeDepsLockOwner(lockDir);
  if (!shouldRemoveRuntimeDepsLock(owner, nowMs)) {
    return false;
  }

  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function withBundledRuntimeDepsFilesystemLock<T>(
  installRoot: string,
  lockName: string,
  run: () => T,
): T {
  fs.mkdirSync(installRoot, { recursive: true });
  const lockDir = path.join(installRoot, lockName);
  const startedAt = Date.now();
  let locked = false;
  while (!locked) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(
          path.join(lockDir, BUNDLED_RUNTIME_DEPS_LOCK_OWNER_FILE),
          `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }, null, 2)}\n`,
          "utf8",
        );
      } catch (ownerWriteError) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw ownerWriteError;
      }
      locked = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      removeRuntimeDepsLockIfStale(lockDir, Date.now());
      const nowMs = Date.now();
      if (nowMs - startedAt > BUNDLED_RUNTIME_DEPS_LOCK_TIMEOUT_MS) {
        throw new Error(
          formatRuntimeDepsLockTimeoutMessage({
            lockDir,
            owner: readRuntimeDepsLockOwner(lockDir),
            waitedMs: nowMs - startedAt,
            nowMs,
          }),
          {
            cause: error,
          },
        );
      }
      sleepSync(BUNDLED_RUNTIME_DEPS_LOCK_WAIT_MS);
    }
  }
  try {
    return run();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function withBundledRuntimeDepsInstallRootLock<T>(installRoot: string, run: () => T): T {
  return withBundledRuntimeDepsFilesystemLock(installRoot, BUNDLED_RUNTIME_DEPS_LOCK_DIR, run);
}

function collectRuntimeDeps(packageJson: JsonObject): Record<string, unknown> {
  return {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.optionalDependencies as Record<string, unknown> | undefined),
  };
}

function collectMirroredPackageRuntimeDeps(
  packageRoot: string | null,
  ownerPluginIds?: ReadonlySet<string>,
): {
  name: string;
  version: string;
  pluginIds: string[];
}[] {
  if (!packageRoot) {
    return [];
  }
  const packageJson = readJsonObject(path.join(packageRoot, "package.json"));
  if (!packageJson) {
    return [];
  }
  const runtimeDeps = collectRuntimeDeps(packageJson);
  const coreRuntimeDeps = MIRRORED_CORE_RUNTIME_DEP_NAMES.flatMap((name) => {
    const dep = parseInstallableRuntimeDep(name, runtimeDeps[name]);
    return dep ? [{ ...dep, pluginIds: [MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID] }] : [];
  });
  return mergeRuntimeDepEntries([
    ...coreRuntimeDeps,
    ...collectRootDistMirroredRuntimeDeps({
      packageRoot,
      runtimeDeps,
      ownerPluginIds,
    }),
  ]);
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("#")
  ) {
    return null;
  }
  const [first, second] = specifier.split("/");
  if (!first) {
    return null;
  }
  return first.startsWith("@") && second ? `${first}/${second}` : first;
}

function extractStaticRuntimeImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  return [...specifiers];
}

function walkRuntimeDistJavaScriptFiles(params: {
  rootDir: string;
  skipTopLevelDirs?: ReadonlySet<string>;
}): string[] {
  if (!fs.existsSync(params.rootDir)) {
    return [];
  }
  const files: string[] = [];
  const queue = [params.rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const isSkippedTopLevelDir =
          path.resolve(current) === path.resolve(params.rootDir) &&
          params.skipTopLevelDirs?.has(entry.name);
        if (entry.name !== "node_modules" && !isSkippedTopLevelDir) {
          queue.push(fullPath);
        }
        continue;
      }
      if (
        entry.isFile() &&
        BUNDLED_RUNTIME_MIRROR_MATERIALIZED_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(fullPath);
      }
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function isPluginOwnedDistImporter(params: {
  relativePath: string;
  source: string;
  pluginIds: readonly string[];
}): boolean {
  return params.pluginIds.some((pluginId) => {
    const pluginPathPrefix = `${BUNDLED_EXTENSION_DIST_DIR}/${pluginId}/`;
    return (
      params.relativePath.startsWith(pluginPathPrefix) ||
      params.source.includes(`//#region ${pluginPathPrefix}`)
    );
  });
}

function collectBundledRuntimeDependencyOwners(packageRoot: string): Map<
  string,
  {
    name: string;
    version: string;
    pluginIds: string[];
  }
> {
  const extensionsDir = path.join(packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return new Map();
  }
  const owners = new Map<string, { name: string; version: string; pluginIds: string[] }>();
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const packageJson = readJsonObject(path.join(extensionsDir, pluginId, "package.json"));
    if (!packageJson) {
      continue;
    }
    for (const [name, rawVersion] of Object.entries(collectRuntimeDeps(packageJson))) {
      const dep = parseInstallableRuntimeDep(name, rawVersion);
      if (!dep) {
        continue;
      }
      const existing = owners.get(dep.name);
      if (existing) {
        existing.pluginIds = [...new Set([...existing.pluginIds, pluginId])].toSorted(
          (left, right) => left.localeCompare(right),
        );
        continue;
      }
      owners.set(dep.name, { ...dep, pluginIds: [pluginId] });
    }
  }
  return owners;
}

function collectRootDistMirroredRuntimeDeps(params: {
  packageRoot: string;
  runtimeDeps: Record<string, unknown>;
  ownerPluginIds?: ReadonlySet<string>;
}): { name: string; version: string; pluginIds: string[] }[] {
  const dependencyOwners = collectBundledRuntimeDependencyOwners(params.packageRoot);
  if (dependencyOwners.size === 0) {
    return [];
  }
  const mirrored = new Map<string, { name: string; version: string; pluginIds: string[] }>();
  const distDir = path.join(params.packageRoot, "dist");
  for (const filePath of walkRuntimeDistJavaScriptFiles({
    rootDir: distDir,
    skipTopLevelDirs: new Set(["extensions"]),
  })) {
    const source = fs.readFileSync(filePath, "utf8");
    const relativePath = path.relative(distDir, filePath).replaceAll(path.sep, "/");
    for (const specifier of extractStaticRuntimeImportSpecifiers(source)) {
      const dependencyName = packageNameFromSpecifier(specifier);
      if (!dependencyName) {
        continue;
      }
      const owner = dependencyOwners.get(dependencyName);
      if (!owner) {
        continue;
      }
      if (
        params.ownerPluginIds &&
        !owner.pluginIds.some((pluginId) => params.ownerPluginIds?.has(pluginId))
      ) {
        continue;
      }
      if (isPluginOwnedDistImporter({ relativePath, source, pluginIds: owner.pluginIds })) {
        continue;
      }
      const dep = parseInstallableRuntimeDep(dependencyName, params.runtimeDeps[dependencyName]);
      if (dep) {
        mirrored.set(dep.name, { ...dep, pluginIds: owner.pluginIds });
      }
    }
  }
  return [...mirrored.values()].toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
}

function mergeInstallableRuntimeDeps(
  deps: readonly { name: string; version: string }[],
): { name: string; version: string }[] {
  const bySpec = new Map<string, { name: string; version: string }>();
  for (const dep of deps) {
    bySpec.set(`${dep.name}@${dep.version}`, dep);
  }
  return [...bySpec.values()].toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
}

function mergeRuntimeDepEntries(deps: readonly RuntimeDepEntry[]): RuntimeDepEntry[] {
  const bySpec = new Map<string, RuntimeDepEntry>();
  for (const dep of deps) {
    const spec = `${dep.name}@${dep.version}`;
    const existing = bySpec.get(spec);
    if (!existing) {
      bySpec.set(spec, { ...dep, pluginIds: [...dep.pluginIds] });
      continue;
    }
    existing.pluginIds = [...new Set([...existing.pluginIds, ...dep.pluginIds])].toSorted(
      (left, right) => left.localeCompare(right),
    );
  }
  return [...bySpec.values()].toSorted((left, right) => {
    const nameOrder = left.name.localeCompare(right.name);
    return nameOrder === 0 ? left.version.localeCompare(right.version) : nameOrder;
  });
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

export function resolveBundledRuntimeDependencyPackageRoot(pluginRoot: string): string | null {
  return resolveBundledPluginPackageRoot(pluginRoot);
}

export function registerBundledRuntimeDependencyNodePath(rootDir: string): void {
  const nodeModulesDir = path.join(rootDir, "node_modules");
  if (registeredBundledRuntimeDepNodePaths.has(nodeModulesDir) || !fs.existsSync(nodeModulesDir)) {
    return;
  }
  const currentPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  process.env.NODE_PATH = [
    nodeModulesDir,
    ...currentPaths.filter((entry) => entry !== nodeModulesDir),
  ].join(path.delimiter);
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
  registeredBundledRuntimeDepNodePaths.add(nodeModulesDir);
}

export function clearBundledRuntimeDependencyNodePaths(): void {
  if (registeredBundledRuntimeDepNodePaths.size === 0) {
    return;
  }
  const retainedPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !registeredBundledRuntimeDepNodePaths.has(entry));
  if (retainedPaths.length > 0) {
    process.env.NODE_PATH = retainedPaths.join(path.delimiter);
  } else {
    delete process.env.NODE_PATH;
  }
  registeredBundledRuntimeDepNodePaths.clear();
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
}

function isPackagedBundledPluginRoot(pluginRoot: string): boolean {
  const packageRoot = resolveBundledPluginPackageRoot(pluginRoot);
  return Boolean(packageRoot && !isSourceCheckoutRoot(packageRoot));
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

function collectAlreadyStagedBundledRuntimeDepSpecs(params: {
  pluginRoot: string;
  installRoot: string;
}): string[] {
  const packageRoot = resolveBundledPluginPackageRoot(params.pluginRoot);
  if (!packageRoot) {
    return [];
  }
  const extensionsDir = path.join(packageRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }
  const { deps } = collectBundledPluginRuntimeDeps({ extensionsDir });
  return deps
    .filter((dep) => hasDependencySentinel([params.installRoot], dep))
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
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

function resolveBundledRuntimeDepsExternalBaseDirs(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.OPENCLAW_PLUGIN_STAGE_DIR?.trim();
  if (explicit) {
    const roots = explicit
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => path.resolve(resolveHomeRelativePath(entry, { env, homedir: os.homedir })));
    if (roots.length > 0) {
      const uniqueRoots: string[] = [];
      for (const root of roots) {
        const existingIndex = uniqueRoots.findIndex(
          (entry) => path.resolve(entry) === path.resolve(root),
        );
        if (existingIndex >= 0) {
          uniqueRoots.splice(existingIndex, 1);
        }
        uniqueRoots.push(root);
      }
      return uniqueRoots;
    }
  }
  const systemdStateDir = resolveSystemdStateDirectory(env);
  if (systemdStateDir) {
    return [path.join(systemdStateDir, "plugin-runtime-deps")];
  }
  return [path.join(resolveStateDir(env, os.homedir), "plugin-runtime-deps")];
}

function resolveExternalBundledRuntimeDepsInstallRoot(params: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}): string {
  return resolveExternalBundledRuntimeDepsInstallRoots(params).at(-1)!;
}

function resolveExternalBundledRuntimeDepsInstallRoots(params: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const packageRoot = resolveBundledPluginPackageRoot(params.pluginRoot) ?? params.pluginRoot;
  const existingExternalRoots = resolveExistingExternalBundledRuntimeDepsRoots({
    packageRoot,
    env: params.env,
  });
  if (existingExternalRoots) {
    return existingExternalRoots;
  }
  const version = sanitizePathSegment(readPackageVersion(packageRoot));
  const packageKey = `openclaw-${version}-${createPathHash(packageRoot)}`;
  return resolveBundledRuntimeDepsExternalBaseDirs(params.env).map((baseDir) =>
    path.join(baseDir, packageKey),
  );
}

function resolveExistingExternalBundledRuntimeDepsRoots(params: {
  packageRoot: string;
  env: NodeJS.ProcessEnv;
}): string[] | null {
  const packageRoot = path.resolve(params.packageRoot);
  const externalBaseDirs = resolveBundledRuntimeDepsExternalBaseDirs(params.env);
  for (const externalBaseDir of externalBaseDirs) {
    const relative = path.relative(path.resolve(externalBaseDir), packageRoot);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const packageKey = relative.split(path.sep)[0];
    if (!packageKey || !packageKey.startsWith("openclaw-")) {
      continue;
    }
    return externalBaseDirs.map((baseDir) => path.join(baseDir, packageKey));
  }
  return null;
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

function findDependencySentinelRoot(
  searchRoots: readonly string[],
  dep: { name: string; version: string },
): string | null {
  return (
    searchRoots.find((rootDir) => {
      const installedVersion = readInstalledDependencyVersion(rootDir, dep.name);
      return (
        typeof installedVersion === "string" &&
        isInstalledDependencyVersionSatisfied(installedVersion, dep.version)
      );
    }) ?? null
  );
}

function dependencyPackageDir(rootDir: string, depName: string): string {
  const normalizedDepName = normalizeInstallableRuntimeDepName(depName);
  if (!normalizedDepName) {
    throw new Error(`Invalid bundled runtime dependency name: ${depName}`);
  }
  return path.join(rootDir, "node_modules", ...normalizedDepName.split("/"));
}

function createBundledRuntimeDepsInstallRootPlan(params: {
  installRoot: string;
  searchRoots: readonly string[];
  external: boolean;
}): BundledRuntimeDepsInstallRootPlan {
  const searchRoots: string[] = [];
  for (const root of params.searchRoots) {
    const resolved = path.resolve(root);
    if (!searchRoots.some((entry) => path.resolve(entry) === resolved)) {
      searchRoots.push(root);
    }
  }
  if (!searchRoots.some((entry) => path.resolve(entry) === path.resolve(params.installRoot))) {
    searchRoots.push(params.installRoot);
  }
  return {
    installRoot: params.installRoot,
    searchRoots,
    external: params.external,
  };
}

export function createBundledRuntimeDepsWritableInstallSpecs(params: {
  deps: readonly { name: string; version: string }[];
  searchRoots: readonly string[];
  installRoot: string;
}): string[] {
  const readOnlyRoots = params.searchRoots.filter(
    (rootDir) => path.resolve(rootDir) !== path.resolve(params.installRoot),
  );
  return params.deps
    .filter((dep) => !hasDependencySentinel(readOnlyRoots, dep))
    .map((dep) => `${dep.name}@${dep.version}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function linkBundledRuntimeDepsFromSearchRoots(params: {
  deps: readonly { name: string; version: string }[];
  searchRoots: readonly string[];
  installRoot: string;
}): void {
  for (const dep of params.deps) {
    if (hasDependencySentinel([params.installRoot], dep)) {
      continue;
    }
    const sourceRoot = findDependencySentinelRoot(params.searchRoots, dep);
    if (!sourceRoot || path.resolve(sourceRoot) === path.resolve(params.installRoot)) {
      continue;
    }
    const sourceDir = dependencyPackageDir(sourceRoot, dep.name);
    const targetDir = dependencyPackageDir(params.installRoot, dep.name);
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    try {
      fs.symlinkSync(sourceDir, targetDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      fs.cpSync(sourceDir, targetDir, { recursive: true });
    }
  }
}

function assertBundledRuntimeDepsInstalled(rootDir: string, specs: readonly string[]): void {
  const missingSpecs = specs.filter((spec) => {
    const dep = parseInstallableRuntimeDepSpec(spec);
    return !hasDependencySentinel([rootDir], dep);
  });
  if (missingSpecs.length === 0) {
    return;
  }
  throw new Error(
    `npm install did not place bundled runtime deps in ${rootDir}: ${missingSpecs.join(", ")}`,
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
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Stale temp dirs are swept at the next runtime-deps pass. Do not fail
      // a node_modules replacement on a transient cleanup race.
    }
  }
}

function linkNodeModulesDir(targetDir: string, sourceDir: string): boolean {
  const parentDir = path.dirname(targetDir);
  const tempLink = path.join(parentDir, `.openclaw-runtime-deps-link-${process.pid}-${Date.now()}`);
  try {
    fs.symlinkSync(sourceDir, tempLink, process.platform === "win32" ? "junction" : "dir");
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(tempLink, targetDir);
    return true;
  } catch {
    try {
      fs.rmSync(tempLink, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; caller falls back to copying.
    }
    return false;
  }
}

function replaceNodeModulesDirFromCache(targetDir: string, sourceDir: string): void {
  if (linkNodeModulesDir(targetDir, sourceDir)) {
    return;
  }
  replaceNodeModulesDir(targetDir, sourceDir);
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
    replaceNodeModulesDirFromCache(
      path.join(params.installRoot, "node_modules"),
      cachedNodeModulesDir,
    );
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

export function createBundledRuntimeDepsInstallEnv(
  env: NodeJS.ProcessEnv,
  options: { cacheDir?: string } = {},
): NodeJS.ProcessEnv {
  return {
    ...createNpmProjectInstallEnv(env, options),
    npm_config_legacy_peer_deps: "true",
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
type BundledPluginRuntimeDepsManifest = {
  channels: string[];
  enabledByDefault: boolean;
};

type BundledPluginRuntimeDepsManifestCache = Map<string, BundledPluginRuntimeDepsManifest>;

function readBundledPluginRuntimeDepsManifest(
  pluginDir: string,
  cache?: BundledPluginRuntimeDepsManifestCache,
): BundledPluginRuntimeDepsManifest {
  const cached = cache?.get(pluginDir);
  if (cached) {
    return cached;
  }
  const manifest = readJsonObject(path.join(pluginDir, "openclaw.plugin.json"));
  const channels = manifest?.channels;
  const runtimeDepsManifest = {
    channels: Array.isArray(channels)
      ? channels.filter((entry): entry is string => typeof entry === "string" && entry !== "")
      : [],
    enabledByDefault: manifest?.enabledByDefault === true,
  };
  cache?.set(pluginDir, runtimeDepsManifest);
  return runtimeDepsManifest;
}

function isBundledPluginConfiguredForRuntimeDeps(params: {
  config: OpenClawConfig;
  pluginId: string;
  pluginDir: string;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
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
  const manifest = readBundledPluginRuntimeDepsManifest(params.pluginDir, params.manifestCache);
  let hasExplicitChannelDisable = false;
  let hasConfiguredChannel = false;
  for (const channelId of manifest.channels) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
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
      (channelConfig as { enabled?: unknown }).enabled === false
    ) {
      hasExplicitChannelDisable = true;
      continue;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      (channelConfig as { enabled?: unknown }).enabled === true
    ) {
      return true;
    }
    if (
      channelConfig &&
      typeof channelConfig === "object" &&
      !Array.isArray(channelConfig) &&
      params.includeConfiguredChannels
    ) {
      hasConfiguredChannel = true;
    }
  }
  if (hasExplicitChannelDisable) {
    return false;
  }
  if (plugins.allow.length > 0 && !plugins.allow.includes(params.pluginId)) {
    return false;
  }
  if (entry?.enabled === true) {
    return true;
  }
  if (hasConfiguredChannel) {
    return true;
  }
  return manifest.enabledByDefault;
}

function shouldIncludeBundledPluginRuntimeDeps(params: {
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  selectedPluginIds?: ReadonlySet<string>;
  pluginId: string;
  pluginDir: string;
  includeConfiguredChannels?: boolean;
  manifestCache?: BundledPluginRuntimeDepsManifestCache;
}): boolean {
  if (params.selectedPluginIds) {
    return params.selectedPluginIds.has(params.pluginId);
  }
  const scopedToPluginIds = Boolean(params.pluginIds);
  if (params.pluginIds) {
    if (!params.pluginIds.has(params.pluginId)) {
      return false;
    }
    if (!params.config) {
      return true;
    }
  }
  if (!params.config) {
    return true;
  }
  if (scopedToPluginIds) {
    const plugins = normalizePluginsConfig(params.config.plugins);
    if (!plugins.enabled || plugins.deny.includes(params.pluginId)) {
      return false;
    }
    const entry = plugins.entries[params.pluginId];
    return entry?.enabled !== false;
  }
  return isBundledPluginConfiguredForRuntimeDeps({
    config: params.config,
    pluginId: params.pluginId,
    pluginDir: params.pluginDir,
    includeConfiguredChannels: params.includeConfiguredChannels,
    manifestCache: params.manifestCache,
  });
}

function collectBundledPluginRuntimeDeps(params: {
  extensionsDir: string;
  config?: OpenClawConfig;
  pluginIds?: ReadonlySet<string>;
  selectedPluginIds?: ReadonlySet<string>;
  includeConfiguredChannels?: boolean;
}): {
  deps: RuntimeDepEntry[];
  conflicts: RuntimeDepConflict[];
  pluginIds: string[];
} {
  const versionMap = new Map<string, Map<string, Set<string>>>();
  const manifestCache: BundledPluginRuntimeDepsManifestCache = new Map();
  const includedPluginIds = new Set<string>();

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
        selectedPluginIds: params.selectedPluginIds,
        pluginId,
        pluginDir,
        includeConfiguredChannels: params.includeConfiguredChannels,
        manifestCache,
      })
    ) {
      continue;
    }
    includedPluginIds.add(pluginId);
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
    pluginIds: [...includedPluginIds].toSorted((a, b) => a.localeCompare(b)),
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
  selectedPluginIds?: readonly string[];
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
  const { deps, conflicts, pluginIds } = collectBundledPluginRuntimeDeps({
    extensionsDir,
    config: params.config,
    pluginIds: normalizePluginIdSet(params.pluginIds),
    selectedPluginIds: normalizePluginIdSet(params.selectedPluginIds),
    includeConfiguredChannels: params.includeConfiguredChannels,
  });
  const packageRuntimeDeps =
    pluginIds.length > 0
      ? collectMirroredPackageRuntimeDeps(params.packageRoot, new Set(pluginIds))
      : [];
  const allDeps = mergeRuntimeDepEntries([...deps, ...packageRuntimeDeps]);
  const packageInstallRootPlan = resolveBundledRuntimeDependencyPackageInstallRootPlan(
    params.packageRoot,
    {
      env: params.env,
    },
  );
  const missing = allDeps.filter((dep) => {
    if (hasDependencySentinel(packageInstallRootPlan.searchRoots, dep)) {
      return false;
    }
    if (dep.pluginIds.includes(MIRRORED_PACKAGE_RUNTIME_DEP_PLUGIN_ID)) {
      return true;
    }
    return dep.pluginIds.every((pluginId) => {
      const pluginRoot = path.join(extensionsDir, pluginId);
      const installRootPlan = resolveBundledRuntimeDependencyInstallRootPlan(pluginRoot, {
        env: params.env,
      });
      return !hasDependencySentinel(installRootPlan.searchRoots, dep);
    });
  });
  return { deps: allDeps, missing, conflicts };
}

export function resolveBundledRuntimeDependencyPackageInstallRootPlan(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRootPlan {
  const env = options.env ?? process.env;
  const externalRoots = resolveExternalBundledRuntimeDepsInstallRoots({
    pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
    env,
  });
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim() ||
    !isSourceCheckoutRoot(packageRoot)
  ) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot:
        externalRoots.at(-1) ??
        resolveExternalBundledRuntimeDepsInstallRoot({
          pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
          env,
        }),
      searchRoots: externalRoots,
      external: true,
    });
  }
  if (isWritableDirectory(packageRoot)) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: packageRoot,
      searchRoots: [packageRoot],
      external: false,
    });
  }
  return createBundledRuntimeDepsInstallRootPlan({
    installRoot:
      externalRoots.at(-1) ??
      resolveExternalBundledRuntimeDepsInstallRoot({
        pluginRoot: path.join(packageRoot, "dist", "extensions", "__package__"),
        env,
      }),
    searchRoots: externalRoots,
    external: true,
  });
}

export function resolveBundledRuntimeDependencyPackageInstallRoot(
  packageRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  return resolveBundledRuntimeDependencyPackageInstallRootPlan(packageRoot, options).installRoot;
}

export function resolveBundledRuntimeDependencyInstallRootPlan(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRootPlan {
  const env = options.env ?? process.env;
  const externalRoots = resolveExternalBundledRuntimeDepsInstallRoots({ pluginRoot, env });
  if (
    options.forceExternal ||
    env.OPENCLAW_PLUGIN_STAGE_DIR?.trim() ||
    env.STATE_DIRECTORY?.trim() ||
    isPackagedBundledPluginRoot(pluginRoot)
  ) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot:
        externalRoots.at(-1) ??
        resolveExternalBundledRuntimeDepsInstallRoot({
          pluginRoot,
          env,
        }),
      searchRoots: externalRoots,
      external: true,
    });
  }
  if (isWritableDirectory(pluginRoot)) {
    return createBundledRuntimeDepsInstallRootPlan({
      installRoot: pluginRoot,
      searchRoots: [pluginRoot],
      external: false,
    });
  }
  return createBundledRuntimeDepsInstallRootPlan({
    installRoot:
      externalRoots.at(-1) ??
      resolveExternalBundledRuntimeDepsInstallRoot({
        pluginRoot,
        env,
      }),
    searchRoots: externalRoots,
    external: true,
  });
}

export function resolveBundledRuntimeDependencyInstallRoot(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): string {
  return resolveBundledRuntimeDependencyInstallRootPlan(pluginRoot, options).installRoot;
}

export function resolveBundledRuntimeDependencyInstallRootInfo(
  pluginRoot: string,
  options: { env?: NodeJS.ProcessEnv; forceExternal?: boolean } = {},
): BundledRuntimeDepsInstallRoot {
  const { installRoot, external } = resolveBundledRuntimeDependencyInstallRootPlan(
    pluginRoot,
    options,
  );
  return {
    installRoot,
    external,
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

function shouldCleanBundledRuntimeDepsInstallExecutionRoot(params: {
  installRoot: string;
  installExecutionRoot: string;
}): boolean {
  const installRoot = path.resolve(params.installRoot);
  const installExecutionRoot = path.resolve(params.installExecutionRoot);
  return installExecutionRoot.startsWith(`${installRoot}${path.sep}`);
}

function createNpmInstallExecutionManifest(installSpecs: readonly string[]): JsonObject {
  const dependencies: Record<string, string> = {};
  for (const spec of installSpecs) {
    const dep = parseInstallableRuntimeDepSpec(spec);
    dependencies[dep.name] = dep.version;
  }
  const sortedDependencies = Object.fromEntries(
    Object.entries(dependencies).toSorted(([left], [right]) => left.localeCompare(right)),
  );
  return {
    name: "openclaw-runtime-deps-install",
    private: true,
    ...(Object.keys(sortedDependencies).length > 0 ? { dependencies: sortedDependencies } : {}),
  };
}

function ensureNpmInstallExecutionManifest(
  installExecutionRoot: string,
  installSpecs: readonly string[] = [],
): void {
  const manifestPath = path.join(installExecutionRoot, "package.json");
  const manifest = createNpmInstallExecutionManifest(installSpecs);
  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  if (fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, "utf8") === nextContents) {
    return;
  }
  fs.writeFileSync(manifestPath, nextContents, "utf8");
}

function formatBundledRuntimeDepsInstallError(result: {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}): string {
  const output = [
    result.error?.message,
    result.signal ? `terminated by ${result.signal}` : null,
    result.stderr,
    result.stdout,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return output || "npm install failed";
}

function formatBundledRuntimeDepsInstallElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function emitBundledRuntimeDepsOutputProgress(
  chunk: Buffer,
  stream: "stdout" | "stderr",
  onProgress: ((message: string) => void) | undefined,
): void {
  if (!onProgress) {
    return;
  }
  const lines = chunk
    .toString("utf8")
    .split(/\r\n|\n|\r/u)
    .map((line) => sanitizeTerminalText(line).trim())
    .filter((line) => line.length > 0)
    .slice(-3);
  for (const line of lines) {
    onProgress(`npm ${stream}: ${line}`);
  }
}

async function spawnBundledRuntimeDepsInstall(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const startedAtMs = Date.now();
    const heartbeat =
      params.onProgress &&
      setInterval(() => {
        params.onProgress?.(
          `npm install still running (${formatBundledRuntimeDepsInstallElapsed(Date.now() - startedAtMs)} elapsed)`,
        );
      }, BUNDLED_RUNTIME_DEPS_INSTALL_PROGRESS_INTERVAL_MS);
    heartbeat?.unref?.();
    const settle = (fn: () => void) => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      fn();
    };
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      emitBundledRuntimeDepsOutputProgress(chunk, "stdout", params.onProgress);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      emitBundledRuntimeDepsOutputProgress(chunk, "stderr", params.onProgress);
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(formatBundledRuntimeDepsInstallError({ error }))));
    });
    child.on("close", (status, signal) => {
      if (status === 0 && !signal) {
        settle(resolve);
        return;
      }
      settle(() =>
        reject(
          new Error(
            formatBundledRuntimeDepsInstallError({
              status,
              signal,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            }),
          ),
        ),
      );
    });
  });
}

export function installBundledRuntimeDeps(params: {
  installRoot: string;
  installExecutionRoot?: string;
  linkNodeModulesFromExecutionRoot?: boolean;
  missingSpecs: string[];
  installSpecs?: string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}): void {
  const installExecutionRoot = params.installExecutionRoot ?? params.installRoot;
  const isolatedExecutionRoot =
    path.resolve(installExecutionRoot) !== path.resolve(params.installRoot);
  const cleanInstallExecutionRoot =
    isolatedExecutionRoot &&
    shouldCleanBundledRuntimeDepsInstallExecutionRoot({
      installRoot: params.installRoot,
      installExecutionRoot,
    });
  try {
    fs.mkdirSync(params.installRoot, { recursive: true });
    fs.mkdirSync(installExecutionRoot, { recursive: true });
    const diskWarning = createLowDiskSpaceWarning({
      targetPath: installExecutionRoot,
      purpose: "bundled plugin runtime dependency staging",
    });
    if (diskWarning) {
      params.warn?.(diskWarning);
    }
    // Always make npm see an OpenClaw-owned package root. The package-level
    // doctor repair path installs directly in the external stage dir; without a
    // manifest, npm can honor a user's global prefix config and write under
    // $HOME/node_modules instead of our managed stage.
    //
    // The manifest also declares retained staged deps. npm may prune packages
    // that are present in node_modules but absent from package dependencies
    // while installing a new explicit spec, so keep retained deps in the
    // manifest and pass only actually missing specs as install args.
    ensureNpmInstallExecutionManifest(
      installExecutionRoot,
      params.installSpecs ?? params.missingSpecs,
    );
    const installEnv = createBundledRuntimeDepsInstallEnv(params.env, {
      cacheDir: path.join(installExecutionRoot, ".openclaw-npm-cache"),
    });
    const npmRunner = resolveBundledRuntimeDepsNpmRunner({
      env: installEnv,
      npmArgs: createBundledRuntimeDepsInstallArgs(params.missingSpecs),
    });
    const result = spawnSync(npmRunner.command, npmRunner.args, {
      cwd: installExecutionRoot,
      encoding: "utf8",
      env: npmRunner.env ?? installEnv,
      stdio: "pipe",
      windowsHide: true,
    });
    if (result.status !== 0 || result.error) {
      throw new Error(formatBundledRuntimeDepsInstallError(result));
    }
    assertBundledRuntimeDepsInstalled(installExecutionRoot, params.missingSpecs);
    if (isolatedExecutionRoot) {
      const stagedNodeModulesDir = path.join(installExecutionRoot, "node_modules");
      if (!fs.existsSync(stagedNodeModulesDir)) {
        throw new Error("npm install did not produce node_modules");
      }
      const targetNodeModulesDir = path.join(params.installRoot, "node_modules");
      if (params.linkNodeModulesFromExecutionRoot) {
        replaceNodeModulesDirFromCache(targetNodeModulesDir, stagedNodeModulesDir);
      } else {
        replaceNodeModulesDir(targetNodeModulesDir, stagedNodeModulesDir);
      }
      assertBundledRuntimeDepsInstalled(params.installRoot, params.missingSpecs);
    }
  } finally {
    if (cleanInstallExecutionRoot) {
      fs.rmSync(installExecutionRoot, { recursive: true, force: true });
    }
  }
}

export async function installBundledRuntimeDepsAsync(params: {
  installRoot: string;
  installExecutionRoot?: string;
  linkNodeModulesFromExecutionRoot?: boolean;
  missingSpecs: string[];
  installSpecs?: string[];
  env: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const installExecutionRoot = params.installExecutionRoot ?? params.installRoot;
  const isolatedExecutionRoot =
    path.resolve(installExecutionRoot) !== path.resolve(params.installRoot);
  const cleanInstallExecutionRoot =
    isolatedExecutionRoot &&
    shouldCleanBundledRuntimeDepsInstallExecutionRoot({
      installRoot: params.installRoot,
      installExecutionRoot,
    });
  try {
    fs.mkdirSync(params.installRoot, { recursive: true });
    fs.mkdirSync(installExecutionRoot, { recursive: true });
    const diskWarning = createLowDiskSpaceWarning({
      targetPath: installExecutionRoot,
      purpose: "bundled plugin runtime dependency staging",
    });
    if (diskWarning) {
      params.warn?.(diskWarning);
    }
    ensureNpmInstallExecutionManifest(
      installExecutionRoot,
      params.installSpecs ?? params.missingSpecs,
    );
    const installEnv = createBundledRuntimeDepsInstallEnv(params.env, {
      cacheDir: path.join(installExecutionRoot, ".openclaw-npm-cache"),
    });
    const npmRunner = resolveBundledRuntimeDepsNpmRunner({
      env: installEnv,
      npmArgs: createBundledRuntimeDepsInstallArgs(params.missingSpecs),
    });
    params.onProgress?.(
      `Starting npm install for bundled plugin runtime deps: ${params.missingSpecs.join(", ")}`,
    );
    await spawnBundledRuntimeDepsInstall({
      command: npmRunner.command,
      args: npmRunner.args,
      cwd: installExecutionRoot,
      env: npmRunner.env ?? installEnv,
      onProgress: params.onProgress,
    });
    assertBundledRuntimeDepsInstalled(installExecutionRoot, params.missingSpecs);
    if (isolatedExecutionRoot) {
      const stagedNodeModulesDir = path.join(installExecutionRoot, "node_modules");
      if (!fs.existsSync(stagedNodeModulesDir)) {
        throw new Error("npm install did not produce node_modules");
      }
      const targetNodeModulesDir = path.join(params.installRoot, "node_modules");
      if (params.linkNodeModulesFromExecutionRoot) {
        replaceNodeModulesDirFromCache(targetNodeModulesDir, stagedNodeModulesDir);
      } else {
        replaceNodeModulesDir(targetNodeModulesDir, stagedNodeModulesDir);
      }
      assertBundledRuntimeDepsInstalled(params.installRoot, params.missingSpecs);
    }
  } finally {
    if (cleanInstallExecutionRoot) {
      fs.rmSync(installExecutionRoot, { recursive: true, force: true });
    }
  }
}

export function repairBundledRuntimeDepsInstallRoot(params: {
  installRoot: string;
  missingSpecs: string[];
  installSpecs: string[];
  env: NodeJS.ProcessEnv;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
  warn?: (message: string) => void;
}): { installSpecs: string[] } {
  return withBundledRuntimeDepsInstallRootLock(params.installRoot, () => {
    const retainedManifestSpecs = readRetainedRuntimeDepsManifest(params.installRoot);
    const installSpecs = [...new Set([...retainedManifestSpecs, ...params.installSpecs])].toSorted(
      (left, right) => left.localeCompare(right),
    );
    const install =
      params.installDeps ??
      ((installParams) =>
        installBundledRuntimeDeps({
          installRoot: installParams.installRoot,
          missingSpecs: installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
          warn: params.warn,
        }));
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot: params.installRoot,
      missingSpecs: params.missingSpecs,
      installSpecs,
    });
    try {
      install({
        installRoot: params.installRoot,
        missingSpecs: params.missingSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    writeRetainedRuntimeDepsManifest(params.installRoot, installSpecs);
    return { installSpecs };
  });
}

async function withBundledRuntimeDepsInstallRootLockAsync<T>(
  installRoot: string,
  run: () => Promise<T>,
): Promise<T> {
  fs.mkdirSync(installRoot, { recursive: true });
  const lockDir = path.join(installRoot, BUNDLED_RUNTIME_DEPS_LOCK_DIR);
  const startedAt = Date.now();
  let locked = false;
  while (!locked) {
    try {
      fs.mkdirSync(lockDir);
      try {
        fs.writeFileSync(
          path.join(lockDir, BUNDLED_RUNTIME_DEPS_LOCK_OWNER_FILE),
          `${JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }, null, 2)}\n`,
          "utf8",
        );
      } catch (ownerWriteError) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw ownerWriteError;
      }
      locked = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      removeRuntimeDepsLockIfStale(lockDir, Date.now());
      const nowMs = Date.now();
      if (nowMs - startedAt > BUNDLED_RUNTIME_DEPS_LOCK_TIMEOUT_MS) {
        throw new Error(
          formatRuntimeDepsLockTimeoutMessage({
            lockDir,
            owner: readRuntimeDepsLockOwner(lockDir),
            waitedMs: nowMs - startedAt,
            nowMs,
          }),
          {
            cause: error,
          },
        );
      }
      await sleep(BUNDLED_RUNTIME_DEPS_LOCK_WAIT_MS);
    }
  }
  try {
    return await run();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export async function repairBundledRuntimeDepsInstallRootAsync(params: {
  installRoot: string;
  missingSpecs: string[];
  installSpecs: string[];
  env: NodeJS.ProcessEnv;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => Promise<void>;
  warn?: (message: string) => void;
  onProgress?: (message: string) => void;
}): Promise<{ installSpecs: string[] }> {
  return await withBundledRuntimeDepsInstallRootLockAsync(params.installRoot, async () => {
    const retainedManifestSpecs = readRetainedRuntimeDepsManifest(params.installRoot);
    const installSpecs = [...new Set([...retainedManifestSpecs, ...params.installSpecs])].toSorted(
      (left, right) => left.localeCompare(right),
    );
    const install =
      params.installDeps ??
      ((installParams) =>
        installBundledRuntimeDepsAsync({
          installRoot: installParams.installRoot,
          missingSpecs: installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
          warn: params.warn,
          onProgress: params.onProgress,
        }));
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot: params.installRoot,
      missingSpecs: params.missingSpecs,
      installSpecs,
    });
    try {
      await install({
        installRoot: params.installRoot,
        missingSpecs: params.missingSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    writeRetainedRuntimeDepsManifest(params.installRoot, installSpecs);
    return { installSpecs };
  });
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
  const pluginDeps = Object.entries(collectRuntimeDeps(packageJson))
    .map(([name, rawVersion]) => parseInstallableRuntimeDep(name, rawVersion))
    .filter((entry): entry is { name: string; version: string } => Boolean(entry));

  const installRootPlan = resolveBundledRuntimeDependencyInstallRootPlan(params.pluginRoot, {
    env: params.env,
  });
  const installRoot = installRootPlan.installRoot;
  const packageRoot = resolveBundledRuntimeDependencyPackageRoot(params.pluginRoot);
  const packageRuntimeDeps =
    packageRoot && path.resolve(installRoot) !== path.resolve(params.pluginRoot)
      ? collectMirroredPackageRuntimeDeps(packageRoot, new Set([params.pluginId]))
      : [];
  const deps = mergeInstallableRuntimeDeps([...pluginDeps, ...packageRuntimeDeps]);
  if (deps.length === 0) {
    return { installedSpecs: [], retainSpecs: [] };
  }
  return withBundledRuntimeDepsInstallRootLock(installRoot, () => {
    const persistRetainedManifest = shouldPersistRetainedRuntimeDepsManifest({
      pluginRoot: params.pluginRoot,
      installRoot,
    });
    if (!persistRetainedManifest) {
      removeRetainedRuntimeDepsManifest(installRoot);
    }
    linkBundledRuntimeDepsFromSearchRoots({
      deps,
      searchRoots: installRootPlan.searchRoots,
      installRoot,
    });
    const dependencySpecs = createBundledRuntimeDepsWritableInstallSpecs({
      deps,
      searchRoots: installRootPlan.searchRoots,
      installRoot,
    });
    const retainedManifestSpecs = persistRetainedManifest
      ? readRetainedRuntimeDepsManifest(installRoot)
      : [];
    const readonlySearchRoots = installRootPlan.searchRoots.filter(
      (rootDir) => path.resolve(rootDir) !== path.resolve(installRoot),
    );
    const alreadyStagedSpecs = persistRetainedManifest
      ? collectAlreadyStagedBundledRuntimeDepSpecs({
          pluginRoot: params.pluginRoot,
          installRoot,
        }).filter(
          (spec) =>
            !hasDependencySentinel(readonlySearchRoots, parseInstallableRuntimeDepSpec(spec)),
        )
      : [];
    const installSpecs = [
      ...new Set([
        ...(params.retainSpecs ?? []),
        ...retainedManifestSpecs,
        ...alreadyStagedSpecs,
        ...dependencySpecs,
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
    const missingSpecs = deps
      .filter((dep) => !hasDependencySentinel(installRootPlan.searchRoots, dep))
      .map((dep) => `${dep.name}@${dep.version}`)
      .toSorted((left, right) => left.localeCompare(right));
    if (missingSpecs.length === 0) {
      if (persistRetainedManifest && installSpecs.length > 0) {
        writeRetainedRuntimeDepsManifest(installRoot, installSpecs);
      }
      return { installedSpecs: [], retainSpecs: [] };
    }
    const cacheDir = resolveSourceCheckoutRuntimeDepsCacheDir({
      pluginId: params.pluginId,
      pluginRoot: params.pluginRoot,
      installSpecs,
    });
    const isPluginRootInstall = path.resolve(installRoot) === path.resolve(params.pluginRoot);
    const sourceCheckoutCacheStage =
      cacheDir && isPluginRootInstall && resolveSourceCheckoutPackageRoot(params.pluginRoot)
        ? cacheDir
        : undefined;
    const installExecutionRoot =
      sourceCheckoutCacheStage ??
      (isPluginRootInstall ? path.join(installRoot, PLUGIN_ROOT_INSTALL_STAGE_DIR) : undefined);
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
      ((installParams) => {
        const isolatedExecutionRoot =
          installParams.installExecutionRoot &&
          path.resolve(installParams.installExecutionRoot) !==
            path.resolve(installParams.installRoot);
        return installBundledRuntimeDeps({
          installRoot: installParams.installRoot,
          installExecutionRoot: installParams.installExecutionRoot,
          linkNodeModulesFromExecutionRoot: installParams.linkNodeModulesFromExecutionRoot,
          missingSpecs: isolatedExecutionRoot
            ? (installParams.installSpecs ?? installParams.missingSpecs)
            : installParams.missingSpecs,
          installSpecs: installParams.installSpecs,
          env: params.env,
        });
      });
    const finishActivity = beginBundledRuntimeDepsInstall({
      installRoot,
      missingSpecs,
      installSpecs,
      pluginId: params.pluginId,
    });
    try {
      install({
        installRoot,
        installExecutionRoot,
        ...(sourceCheckoutCacheStage ? { linkNodeModulesFromExecutionRoot: true } : {}),
        missingSpecs,
        installSpecs,
      });
    } finally {
      finishActivity();
    }
    linkBundledRuntimeDepsFromSearchRoots({
      deps,
      searchRoots: installRootPlan.searchRoots,
      installRoot,
    });
    const cacheAlreadyPopulated = Boolean(
      sourceCheckoutCacheStage && hasAllDependencySentinels(sourceCheckoutCacheStage, deps),
    );
    if (persistRetainedManifest) {
      writeRetainedRuntimeDepsManifest(installRoot, installSpecs);
    }
    if (!cacheAlreadyPopulated) {
      storeSourceCheckoutRuntimeDepsCache({ cacheDir, installRoot });
    }
    return { installedSpecs: missingSpecs, retainSpecs: installSpecs };
  });
}
