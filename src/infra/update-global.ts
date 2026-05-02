import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { pathExists } from "../utils.js";
import {
  collectPackageDistInventory,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import { applyPathPrepend } from "./path-prepend.js";
import { parseSemver } from "./runtime-guard.js";

export type GlobalInstallManager = "npm" | "pnpm" | "bun";

export type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

type ResolvedGlobalInstallCommand = {
  manager: GlobalInstallManager;
  command: string;
};

export type ResolvedGlobalInstallTarget = ResolvedGlobalInstallCommand & {
  globalRoot: string | null;
  packageRoot: string | null;
};

const PRIMARY_PACKAGE_NAME = "openclaw";
const ALL_PACKAGE_NAMES = [PRIMARY_PACKAGE_NAME] as const;
const GLOBAL_RENAME_PREFIX = ".";
export const OPENCLAW_MAIN_PACKAGE_SPEC = "github:openclaw/openclaw#main";
const COREPACK_ENABLE_DOWNLOAD_PROMPT_DEFAULT = "0";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = ["--no-fund", "--no-audit", "--loglevel=error"] as const;
const NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS = [
  "--omit=optional",
  ...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
] as const;
const FIRST_PACKAGED_DIST_INVENTORY_VERSION = { major: 2026, minor: 4, patch: 15 };
const OMITTED_PRIVATE_QA_BUNDLED_PLUGIN_ROOTS = new Set([
  "dist/extensions/qa-channel",
  "dist/extensions/qa-lab",
  "dist/extensions/qa-matrix",
]);

export type NpmGlobalPrefixLayout = {
  prefix: string;
  globalRoot: string;
  binDir: string;
};

function normalizePackageTarget(value: string): string {
  return value.trim();
}

export function isMainPackageTarget(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(normalizePackageTarget(value)) === "main";
}

export function isExplicitPackageInstallSpec(value: string): boolean {
  const trimmed = normalizePackageTarget(value);
  if (!trimmed) {
    return false;
  }
  return (
    trimmed.includes("://") ||
    trimmed.includes("#") ||
    /^(?:file|github|git\+ssh|git\+https|git\+http|git\+file|npm):/i.test(trimmed)
  );
}

export function resolveExpectedInstalledVersionFromSpec(
  packageName: string,
  spec: string,
): string | null {
  const normalizedPackageName = packageName.trim();
  const normalizedSpec = normalizePackageTarget(spec);
  if (!normalizedPackageName || !normalizedSpec.startsWith(`${normalizedPackageName}@`)) {
    return null;
  }
  const rawVersion = normalizedSpec.slice(normalizedPackageName.length + 1).trim();
  if (
    !rawVersion ||
    rawVersion.includes("/") ||
    rawVersion.includes(":") ||
    rawVersion.includes("#") ||
    /^(latest|beta|next|main)$/i.test(rawVersion)
  ) {
    return null;
  }
  return rawVersion;
}

export async function collectInstalledGlobalPackageErrors(params: {
  packageRoot: string;
  expectedVersion?: string | null;
}): Promise<string[]> {
  const errors: string[] = [];
  errors.push(...(await collectSourceCheckoutInstallErrors(params.packageRoot)));
  const installedVersion = await readPackageVersion(params.packageRoot);
  if (params.expectedVersion && installedVersion !== params.expectedVersion) {
    errors.push(
      `expected installed version ${params.expectedVersion}, found ${installedVersion ?? "<missing>"}`,
    );
  }
  errors.push(
    ...(await collectInstalledPackageDistErrors({
      packageRoot: params.packageRoot,
      installedVersion,
      expectedVersion: params.expectedVersion,
    })),
  );
  return errors;
}

async function collectSourceCheckoutInstallErrors(packageRoot: string): Promise<string[]> {
  const realPackageRoot = await tryRealpath(packageRoot);
  const hasSourceCheckoutShape =
    ((await pathExists(path.join(realPackageRoot, ".git"))) ||
      (await pathExists(path.join(realPackageRoot, "pnpm-workspace.yaml")))) &&
    (await pathExists(path.join(realPackageRoot, "src"))) &&
    (await pathExists(path.join(realPackageRoot, "extensions")));
  return hasSourceCheckoutShape
    ? [`global package root resolves to source checkout: ${realPackageRoot}`]
    : [];
}

function shouldRequirePackagedDistInventory(version: string | null | undefined): boolean {
  const parsed = parseSemver(version ?? null);
  if (!parsed) {
    return false;
  }
  if (parsed.major !== FIRST_PACKAGED_DIST_INVENTORY_VERSION.major) {
    return parsed.major > FIRST_PACKAGED_DIST_INVENTORY_VERSION.major;
  }
  if (parsed.minor !== FIRST_PACKAGED_DIST_INVENTORY_VERSION.minor) {
    return parsed.minor > FIRST_PACKAGED_DIST_INVENTORY_VERSION.minor;
  }
  return parsed.patch >= FIRST_PACKAGED_DIST_INVENTORY_VERSION.patch;
}

async function collectInstalledPackageDistErrors(params: {
  packageRoot: string;
  installedVersion: string | null;
  expectedVersion?: string | null;
}): Promise<string[]> {
  const criticalPaths = await collectCriticalInstalledPackageDistPaths(params.packageRoot);
  let inventoryFiles: string[] | null = null;
  let inventoryError: string | null = null;
  try {
    inventoryFiles = await readPackageDistInventoryIfPresent(params.packageRoot);
  } catch {
    inventoryError = `invalid package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`;
  }

  if (inventoryFiles !== null) {
    const actualFiles = await collectPackageDistInventory(params.packageRoot);
    const inventoryErrors = await collectInstalledPathErrors({
      packageRoot: params.packageRoot,
      expectedFiles: inventoryFiles,
      actualFiles,
      missingMessage: (relativePath) => `missing packaged dist file ${relativePath}`,
      unexpectedMessage: (relativePath) => `unexpected packaged dist file ${relativePath}`,
    });
    const inventorySet = new Set(inventoryFiles);
    const supplementalCriticalPaths = criticalPaths.filter(
      (relativePath) => !inventorySet.has(relativePath),
    );
    if (supplementalCriticalPaths.length === 0) {
      return inventoryErrors;
    }
    return [
      ...inventoryErrors,
      ...(await collectInstalledPathErrors({
        packageRoot: params.packageRoot,
        expectedFiles: supplementalCriticalPaths,
        actualFiles,
        missingMessage: (relativePath) => `missing bundled runtime sidecar ${relativePath}`,
      })),
    ];
  }

  const criticalErrors = await collectInstalledPathErrors({
    packageRoot: params.packageRoot,
    expectedFiles: await collectLegacyInstalledPackageDistPaths(params.packageRoot),
    actualFiles: null,
    missingMessage: (relativePath) => `missing bundled runtime sidecar ${relativePath}`,
  });
  if (inventoryError) {
    return [inventoryError, ...criticalErrors];
  }
  if (
    shouldRequirePackagedDistInventory(params.installedVersion) ||
    shouldRequirePackagedDistInventory(params.expectedVersion)
  ) {
    return [
      `missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
      ...criticalErrors,
    ];
  }
  return criticalErrors;
}

async function collectLegacyInstalledPackageDistPaths(packageRoot: string): Promise<string[]> {
  return await collectCriticalInstalledPackageDistPaths(packageRoot);
}

async function collectCriticalInstalledPackageDistPaths(packageRoot: string): Promise<string[]> {
  const expectedFiles = new Set<string>();
  await Promise.all(
    BUNDLED_RUNTIME_SIDECAR_PATHS.map(async (relativePath) => {
      const pluginRoot = resolveBundledPluginRoot(relativePath);
      if (pluginRoot === null) {
        return;
      }
      if (OMITTED_PRIVATE_QA_BUNDLED_PLUGIN_ROOTS.has(pluginRoot)) {
        return;
      }
      if (
        (await pathExists(path.join(packageRoot, pluginRoot, "package.json"))) ||
        (await pathExists(path.join(packageRoot, pluginRoot, "openclaw.plugin.json")))
      ) {
        expectedFiles.add(relativePath);
      }
    }),
  );
  return [...expectedFiles].toSorted((left, right) => left.localeCompare(right));
}

function resolveBundledPluginRoot(relativePath: string): string | null {
  const match = /^dist\/extensions\/[^/]+/u.exec(relativePath);
  return match ? match[0] : null;
}

async function collectInstalledPathErrors(params: {
  packageRoot: string;
  expectedFiles: string[];
  actualFiles: string[] | null;
  missingMessage: (relativePath: string) => string;
  unexpectedMessage?: ((relativePath: string) => string) | undefined;
}): Promise<string[]> {
  const errors: string[] = [];
  const actualSet = params.actualFiles ? new Set(params.actualFiles) : null;
  for (const relativePath of params.expectedFiles) {
    const exists =
      actualSet !== null
        ? actualSet.has(relativePath)
        : await pathExists(path.join(params.packageRoot, relativePath));
    if (!exists) {
      errors.push(params.missingMessage(relativePath));
    }
  }
  if (actualSet !== null && params.unexpectedMessage) {
    const expectedSet = new Set(params.expectedFiles);
    for (const relativePath of params.actualFiles ?? []) {
      if (!expectedSet.has(relativePath)) {
        errors.push(params.unexpectedMessage(relativePath));
      }
    }
  }
  return errors;
}

export function canResolveRegistryVersionForPackageTarget(value: string): boolean {
  const trimmed = normalizePackageTarget(value);
  if (!trimmed) {
    return true;
  }
  return !isMainPackageTarget(trimmed) && !isExplicitPackageInstallSpec(trimmed);
}

async function resolvePortableGitPathPrepend(
  env: NodeJS.ProcessEnv | undefined,
): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const localAppData = env?.LOCALAPPDATA?.trim() || process.env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return [];
  }
  const portableGitRoot = path.join(localAppData, "OpenClaw", "deps", "portable-git");
  const candidates = [
    path.join(portableGitRoot, "mingw64", "bin"),
    path.join(portableGitRoot, "usr", "bin"),
    path.join(portableGitRoot, "cmd"),
    path.join(portableGitRoot, "bin"),
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

function applyWindowsPackageInstallEnv(env: Record<string, string>) {
  if (process.platform !== "win32") {
    return;
  }
  env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  env.NPM_CONFIG_FUND = "false";
  env.NPM_CONFIG_AUDIT = "false";
  env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";
}

function applyCorepackDownloadPromptEnv(env: Record<string, string>) {
  const current = env.COREPACK_ENABLE_DOWNLOAD_PROMPT?.trim();
  if (!current) {
    env.COREPACK_ENABLE_DOWNLOAD_PROMPT = COREPACK_ENABLE_DOWNLOAD_PROMPT_DEFAULT;
  }
}

export function resolveGlobalInstallSpec(params: {
  packageName: string;
  tag: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const override =
    params.env?.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim() ||
    process.env.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim();
  if (override) {
    return override;
  }
  const target = normalizePackageTarget(params.tag);
  if (isMainPackageTarget(target)) {
    return OPENCLAW_MAIN_PACKAGE_SPEC;
  }
  if (isExplicitPackageInstallSpec(target)) {
    return target;
  }
  return `${params.packageName}@${target}`;
}

export async function createGlobalInstallEnv(
  env?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv | undefined> {
  const pathPrepend = await resolvePortableGitPathPrepend(env);
  const sourceEnv = env ?? process.env;
  const hasCorepackDownloadPromptSetting = Boolean(
    sourceEnv.COREPACK_ENABLE_DOWNLOAD_PROMPT?.trim(),
  );
  const requiresMergedEnv =
    pathPrepend.length > 0 || process.platform === "win32" || !hasCorepackDownloadPromptSetting;
  if (!requiresMergedEnv) {
    return env;
  }
  const merged = Object.fromEntries(
    Object.entries(sourceEnv)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  ) as Record<string, string>;
  applyPathPrepend(merged, pathPrepend);
  applyWindowsPackageInstallEnv(merged);
  applyCorepackDownloadPromptEnv(merged);
  return merged;
}

async function tryRealpath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function resolveBunGlobalRoot(): string {
  const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
  return path.join(bunInstall, "install", "global", "node_modules");
}

function inferNpmPrefixFromPackageRoot(pkgRoot?: string | null): string | null {
  const trimmed = pkgRoot?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.resolve(trimmed);
  const nodeModulesDir = path.dirname(normalized);
  if (path.basename(nodeModulesDir) !== "node_modules") {
    return null;
  }
  const parentDir = path.dirname(nodeModulesDir);
  if (path.basename(parentDir) === "lib") {
    return path.dirname(parentDir);
  }
  if (
    process.platform === "win32" &&
    normalizeLowercaseStringOrEmpty(path.basename(parentDir)) === "npm"
  ) {
    return parentDir;
  }
  return null;
}

export function resolveNpmGlobalPrefixLayoutFromGlobalRoot(
  globalRoot?: string | null,
): NpmGlobalPrefixLayout | null {
  const trimmed = globalRoot?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.resolve(trimmed);
  if (path.basename(normalized) !== "node_modules") {
    return null;
  }
  const parentDir = path.dirname(normalized);
  if (path.basename(parentDir) === "lib") {
    const prefix = path.dirname(parentDir);
    return {
      prefix,
      globalRoot: normalized,
      binDir: path.join(prefix, "bin"),
    };
  }
  if (process.platform === "win32") {
    return {
      prefix: parentDir,
      globalRoot: normalized,
      binDir: parentDir,
    };
  }
  return null;
}

export function resolveNpmGlobalPrefixLayoutFromPrefix(prefix: string): NpmGlobalPrefixLayout {
  const resolvedPrefix = path.resolve(prefix);
  if (process.platform === "win32") {
    return {
      prefix: resolvedPrefix,
      globalRoot: path.join(resolvedPrefix, "node_modules"),
      binDir: resolvedPrefix,
    };
  }
  return {
    prefix: resolvedPrefix,
    globalRoot: path.join(resolvedPrefix, "lib", "node_modules"),
    binDir: path.join(resolvedPrefix, "bin"),
  };
}

function resolvePreferredNpmCommand(pkgRoot?: string | null): string | null {
  const prefix = inferNpmPrefixFromPackageRoot(pkgRoot);
  if (!prefix) {
    return null;
  }
  const candidate =
    process.platform === "win32" ? path.join(prefix, "npm.cmd") : path.join(prefix, "bin", "npm");
  return fsSync.existsSync(candidate) ? candidate : null;
}

function resolvePreferredGlobalManagerCommand(
  manager: GlobalInstallManager,
  pkgRoot?: string | null,
): string {
  if (manager !== "npm") {
    return manager;
  }
  return resolvePreferredNpmCommand(pkgRoot) ?? manager;
}

export function resolveGlobalInstallCommand(
  manager: GlobalInstallManager,
  pkgRoot?: string | null,
): ResolvedGlobalInstallCommand {
  return {
    manager,
    command: resolvePreferredGlobalManagerCommand(manager, pkgRoot),
  };
}

function normalizeGlobalInstallCommand(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  pkgRoot?: string | null,
): ResolvedGlobalInstallCommand {
  return typeof managerOrCommand === "string"
    ? resolveGlobalInstallCommand(managerOrCommand, pkgRoot)
    : managerOrCommand;
}

export async function resolveGlobalRoot(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  runCommand: CommandRunner,
  timeoutMs: number,
  pkgRoot?: string | null,
): Promise<string | null> {
  const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
  if (resolved.manager === "bun") {
    return resolveBunGlobalRoot();
  }
  const argv = [resolved.command, "root", "-g"];
  const res = await runCommand(argv, { timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const root = res.stdout.trim();
  return root || null;
}

export async function resolveGlobalPackageRoot(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  runCommand: CommandRunner,
  timeoutMs: number,
  pkgRoot?: string | null,
): Promise<string | null> {
  const root = await resolveGlobalRoot(managerOrCommand, runCommand, timeoutMs, pkgRoot);
  if (!root) {
    return null;
  }
  return path.join(root, PRIMARY_PACKAGE_NAME);
}

export async function resolveGlobalInstallTarget(params: {
  manager: GlobalInstallManager | ResolvedGlobalInstallCommand;
  runCommand: CommandRunner;
  timeoutMs: number;
  pkgRoot?: string | null;
}): Promise<ResolvedGlobalInstallTarget> {
  const command = normalizeGlobalInstallCommand(params.manager, params.pkgRoot);
  const globalRoot = await resolveGlobalRoot(
    command,
    params.runCommand,
    params.timeoutMs,
    params.pkgRoot,
  );
  return {
    ...command,
    globalRoot,
    packageRoot: globalRoot ? path.join(globalRoot, PRIMARY_PACKAGE_NAME) : null,
  };
}

export async function detectGlobalInstallManagerForRoot(
  runCommand: CommandRunner,
  pkgRoot: string,
  timeoutMs: number,
): Promise<GlobalInstallManager | null> {
  const pkgReal = await tryRealpath(pkgRoot);

  const candidates: Array<{
    manager: "npm" | "pnpm";
    argv: string[];
  }> = [
    { manager: "npm", argv: ["npm", "root", "-g"] },
    { manager: "pnpm", argv: ["pnpm", "root", "-g"] },
  ];

  for (const { manager, argv } of candidates) {
    const res = await runCommand(argv, { timeoutMs }).catch(() => null);
    if (!res || res.code !== 0) {
      continue;
    }
    const globalRoot = res.stdout.trim();
    if (!globalRoot) {
      continue;
    }
    const globalReal = await tryRealpath(globalRoot);
    for (const name of ALL_PACKAGE_NAMES) {
      const expected = path.join(globalReal, name);
      const expectedReal = await tryRealpath(expected);
      if (path.resolve(expectedReal) === path.resolve(pkgReal)) {
        return manager;
      }
    }
  }

  const bunGlobalRoot = resolveBunGlobalRoot();
  const bunGlobalReal = await tryRealpath(bunGlobalRoot);
  for (const name of ALL_PACKAGE_NAMES) {
    const bunExpected = path.join(bunGlobalReal, name);
    const bunExpectedReal = await tryRealpath(bunExpected);
    if (path.resolve(bunExpectedReal) === path.resolve(pkgReal)) {
      return "bun";
    }
  }

  if (resolvePreferredNpmCommand(pkgRoot)) {
    return "npm";
  }

  return null;
}

export async function detectGlobalInstallManagerByPresence(
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<GlobalInstallManager | null> {
  for (const manager of ["npm", "pnpm"] as const) {
    const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
    if (!root) {
      continue;
    }
    for (const name of ALL_PACKAGE_NAMES) {
      if (await pathExists(path.join(root, name))) {
        return manager;
      }
    }
  }

  const bunRoot = resolveBunGlobalRoot();
  for (const name of ALL_PACKAGE_NAMES) {
    if (await pathExists(path.join(bunRoot, name))) {
      return "bun";
    }
  }
  return null;
}

export function globalInstallArgs(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  spec: string,
  pkgRoot?: string | null,
  installPrefix?: string | null,
): string[] {
  const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
  if (resolved.manager === "pnpm") {
    return [resolved.command, "add", "-g", spec];
  }
  if (resolved.manager === "bun") {
    return [resolved.command, "add", "-g", spec];
  }
  return [
    resolved.command,
    "i",
    "-g",
    ...(installPrefix ? ["--prefix", installPrefix] : []),
    spec,
    ...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
  ];
}

export function globalInstallFallbackArgs(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  spec: string,
  pkgRoot?: string | null,
  installPrefix?: string | null,
): string[] | null {
  const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
  if (resolved.manager !== "npm") {
    return null;
  }
  return [
    resolved.command,
    "i",
    "-g",
    ...(installPrefix ? ["--prefix", installPrefix] : []),
    spec,
    ...NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS,
  ];
}

export async function cleanupGlobalRenameDirs(params: {
  globalRoot: string;
  packageName: string;
}): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const root = params.globalRoot.trim();
  const name = params.packageName.trim();
  if (!root || !name) {
    return { removed };
  }
  const prefix = `${GLOBAL_RENAME_PREFIX}${name}-`;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const target = path.join(root, entry);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory()) {
        continue;
      }
      await fs.rm(target, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // ignore cleanup failures
    }
  }
  return { removed };
}
