// Runs package-manager based global update and install flows.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { pathExists } from "../utils.js";
import {
  applyNpmFreshnessBypassEnv,
  applyPosixNpmScriptShellEnv,
  createNpmFreshnessBypassArgs,
} from "./npm-install-env.js";
import {
  collectPackageDistInventory,
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import { applyPathPrepend } from "./path-prepend.js";
import { parseSemver } from "./runtime-guard.js";

/** Supported package managers for OpenClaw global install and update flows. */
export type GlobalInstallManager = "npm" | "pnpm" | "bun";

/** Runs package-manager commands with timeout and environment control. */
export type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}>;

type ResolvedGlobalInstallCommand = {
  manager: GlobalInstallManager;
  command: string;
  pnpmIsolated?: {
    layoutVersion: number;
    globalBinDir?: string;
  };
};

/**
 * Resolved package-manager command plus the root paths used for install,
 * verification, and staged package swaps.
 */
export type ResolvedGlobalInstallTarget = ResolvedGlobalInstallCommand & {
  globalRoot: string | null;
  packageRoot: string | null;
  directNodeModulesRoot?: boolean;
};

const PRIMARY_PACKAGE_NAME = "openclaw";
const ALL_PACKAGE_NAMES = [PRIMARY_PACKAGE_NAME] as const;
const GLOBAL_RENAME_PREFIX = ".";
/** npm-compatible spec used when the user asks to install the moving main branch. */
const OPENCLAW_MAIN_PACKAGE_SPEC = "github:openclaw/openclaw#main";
const COREPACK_ENABLE_DOWNLOAD_PROMPT_DEFAULT = "0";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = ["--no-fund", "--no-audit", "--loglevel=error"] as const;
const PNPM_OPENCLAW_BUILD_ALLOWLIST_FLAG = `--allow-build=${PRIMARY_PACKAGE_NAME}`;
const BUN_OPENCLAW_TRUST_FLAG = "--trust";
const FIRST_PACKAGED_DIST_INVENTORY_VERSION = { major: 2026, minor: 4, patch: 15 };
const OMITTED_PRIVATE_QA_BUNDLED_PLUGIN_ROOTS = new Set([
  "dist/extensions/qa-channel",
  "dist/extensions/qa-lab",
]);

/** npm prefix layout paths needed to install, stage, and expose global bins. */
export type NpmGlobalPrefixLayout = {
  prefix: string;
  globalRoot: string;
  binDir: string;
};

function normalizePackageTarget(value: string): string {
  return value.trim();
}

/** Reads the command value after package-manager warnings printed on stdout. */
export function readPackageManagerProbeValue(stdout: string): string {
  const lines = stdout.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = lines[index]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function normalizePackageVersionForComparison(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^[vV](?=\d)/, "");
}

/** Returns true when a user target requests the moving main-branch package spec. */
function isMainPackageTarget(value: string): boolean {
  return normalizeLowercaseStringOrEmpty(normalizePackageTarget(value)) === "main";
}

/**
 * Returns true for targets that should pass through as package-manager specs
 * rather than being treated as registry dist-tags.
 */
function isExplicitPackageInstallSpec(value: string): boolean {
  const trimmed = normalizePackageTarget(value);
  if (!trimmed) {
    return false;
  }
  return (
    /\.(?:tgz|tar\.gz)$/iu.test(trimmed) ||
    trimmed.includes("://") ||
    trimmed.includes("#") ||
    /^(?:file|github|git\+ssh|git\+https|git\+http|git\+file|npm):/i.test(trimmed)
  );
}

function isRelativePackageInstallPath(value: string): boolean {
  return /^(?:\.{1,2})(?:[\\/]|$)/u.test(value);
}

function resolveNpmInstallScriptsAllowFlag(spec: string, installCwd?: string | null): string {
  const normalized = normalizePackageTarget(spec);
  const unaliased = stripPrimaryPackageAlias(normalized);
  let identity =
    isExplicitPackageInstallSpec(normalized) ||
    isExplicitPackageInstallSpec(unaliased) ||
    isRelativePackageInstallPath(unaliased) ||
    path.isAbsolute(normalized) ||
    path.isAbsolute(unaliased)
      ? unaliased
      : PRIMARY_PACKAGE_NAME;
  identity = resolveNpmAliasPackageName(identity) ?? identity;
  if (installCwd && path.isAbsolute(identity)) {
    // npm resolves relative allow-scripts identities against its cwd. Relativize
    // first so commas in ancestor directories do not split the policy value.
    const relativeIdentity = path.relative(installCwd, identity) || ".";
    identity =
      path.isAbsolute(relativeIdentity) ||
      relativeIdentity === "." ||
      relativeIdentity === ".." ||
      relativeIdentity.startsWith(`..${path.sep}`)
        ? relativeIdentity
        : `./${relativeIdentity}`;
  }
  if (identity.includes(",")) {
    throw new Error(
      "npm cannot allow lifecycle scripts for an install target containing a comma; rename the package or source path",
    );
  }
  return `--allow-scripts=${identity || PRIMARY_PACKAGE_NAME}`;
}

function resolveNpmAliasPackageName(spec: string): string | null {
  if (!/^npm:/i.test(spec)) {
    return null;
  }
  const target = spec.slice(spec.indexOf(":") + 1).trim();
  if (target.startsWith("@")) {
    const scopeSeparator = target.indexOf("/");
    if (scopeSeparator <= 1) {
      return null;
    }
    const versionSeparator = target.indexOf("@", scopeSeparator + 1);
    return versionSeparator === -1 ? target : target.slice(0, versionSeparator);
  }
  const versionSeparator = target.indexOf("@");
  const packageName = versionSeparator === -1 ? target : target.slice(0, versionSeparator);
  return packageName || null;
}

function stripPrimaryPackageAlias(spec: string): string {
  const normalized = normalizePackageTarget(spec);
  const prefix = `${PRIMARY_PACKAGE_NAME}@`;
  return normalized.toLowerCase().startsWith(prefix)
    ? normalized.slice(prefix.length).trim()
    : normalized;
}

/**
 * Extracts a pinned installed version from package specs like `openclaw@1.2.3`.
 * Moving tags, URLs, git refs, and aliases return null because they cannot be
 * compared reliably after install.
 */
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
  return normalizePackageVersionForComparison(rawVersion);
}

/**
 * Verifies that a global package root looks like a packaged OpenClaw install
 * and, when supplied, matches the expected concrete version.
 */
export async function collectInstalledGlobalPackageErrors(params: {
  packageRoot: string;
  expectedVersion?: string | null;
}): Promise<string[]> {
  const errors: string[] = [];
  errors.push(...(await collectSourceCheckoutInstallErrors(params.packageRoot)));
  const installedVersion = await readPackageVersion(params.packageRoot);
  const expectedComparable = normalizePackageVersionForComparison(params.expectedVersion);
  const installedComparable = normalizePackageVersionForComparison(installedVersion);
  if (expectedComparable && installedComparable !== expectedComparable) {
    errors.push(
      `expected installed version ${expectedComparable}, found ${installedComparable ?? "<missing>"}`,
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

/**
 * Returns true when a target can be resolved through npm registry metadata.
 * Explicit tarball, URL, git, and main-branch specs bypass registry lookup.
 */
export function canResolveRegistryVersionForPackageTarget(value: string): boolean {
  const trimmed = normalizePackageTarget(value);
  if (!trimmed) {
    return true;
  }
  return !isMainPackageTarget(trimmed) && !isExplicitPackageInstallSpec(trimmed);
}

async function resolvePortableGitPathPrepend(): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
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

/**
 * Converts a user tag or explicit package target into the package-manager spec
 * used by global install commands.
 */
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

/**
 * Builds the package-manager environment used for global installs.
 * It keeps caller env values, adds platform-specific install defaults, and
 * disables npm/corepack prompts that would otherwise hang unattended updates.
 */
export async function createGlobalInstallEnv(
  env?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv | undefined> {
  const pathPrepend = await resolvePortableGitPathPrepend();
  const sourceEnv = env ?? process.env;
  const merged = Object.fromEntries(
    Object.entries(sourceEnv)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  ) as Record<string, string>;
  applyPathPrepend(merged, pathPrepend);
  applyWindowsPackageInstallEnv(merged);
  applyCorepackDownloadPromptEnv(merged);
  applyNpmFreshnessBypassEnv(merged);
  applyPosixNpmScriptShellEnv(merged);
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
  const nodeModulesDir = inferGlobalRootFromPackageRoot(pkgRoot);
  if (!nodeModulesDir) {
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

/**
 * Infers npm prefix, package root, and bin paths from an npm global root.
 * Direct `node_modules` roots are accepted only when the caller opts into them.
 */
export function resolveNpmGlobalPrefixLayoutFromGlobalRoot(
  globalRoot?: string | null,
  options: { allowDirectNodeModulesRoot?: boolean } = {},
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
  if (options.allowDirectNodeModulesRoot) {
    return {
      prefix: parentDir,
      globalRoot: normalized,
      binDir: path.join(normalized, ".bin"),
    };
  }
  return null;
}

/**
 * Derives npm's global package and bin directories from a prefix root.
 * Used for staged installs where OpenClaw creates the prefix itself.
 */
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

function splitNormalizedPathParts(value: string): string[] {
  return path
    .resolve(value)
    .split(path.sep)
    .filter(Boolean)
    .map((part) => normalizeLowercaseStringOrEmpty(part));
}

function isNodeVersionPathPart(value: string | undefined): boolean {
  return value !== undefined && /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9a-z.-]+)?$/u.test(value);
}

function hasPathSequence(parts: readonly string[], sequence: readonly string[]): boolean {
  const lastStart = parts.length - sequence.length;
  for (let index = 0; index <= lastStart; index += 1) {
    if (sequence.every((part, offset) => parts[index + offset] === part)) {
      return true;
    }
  }
  return false;
}

function isEphemeralNodeManagedNpmPrefix(prefix: string): boolean {
  const parts = splitNormalizedPathParts(prefix);
  const basename = parts.at(-1);
  const parent = parts.at(-2);
  const grandparent = parts.at(-3);

  if (isNodeVersionPathPart(basename) && grandparent === "cellar") {
    return true;
  }
  if (
    isNodeVersionPathPart(basename) &&
    (hasPathSequence(parts, [".nvm", "versions", "node"]) ||
      hasPathSequence(parts, ["n", "versions", "node"]) ||
      hasPathSequence(parts, [".asdf", "installs", "nodejs"]) ||
      hasPathSequence(parts, [".volta", "tools", "image", "node"]))
  ) {
    return true;
  }
  return (
    basename === "installation" && isNodeVersionPathPart(parent) && grandparent === "node-versions"
  );
}

function resolveNpmCommandBesidePackageRoot(pkgRoot?: string | null): string | null {
  const prefix = inferNpmPrefixFromPackageRoot(pkgRoot);
  if (!prefix) {
    return null;
  }
  const candidate =
    process.platform === "win32" ? path.join(prefix, "npm.cmd") : path.join(prefix, "bin", "npm");
  return fsSync.existsSync(candidate) ? candidate : null;
}

function resolvePreferredNpmCommand(pkgRoot?: string | null): string | null {
  const prefix = inferNpmPrefixFromPackageRoot(pkgRoot);
  if (prefix && isEphemeralNodeManagedNpmPrefix(prefix)) {
    return null;
  }
  return resolveNpmCommandBesidePackageRoot(pkgRoot);
}

function inferGlobalRootFromPackageRoot(pkgRoot?: string | null): string | null {
  const trimmed = pkgRoot?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.resolve(trimmed);
  let globalRoot = path.dirname(normalized);
  if (path.basename(globalRoot).startsWith("@")) {
    globalRoot = path.dirname(globalRoot);
  }
  return path.basename(globalRoot) === "node_modules" ? globalRoot : null;
}

function resolvePackageRootFromGlobalRoot(params: {
  globalRoot: string;
  packageName?: string;
}): string {
  const packageName = params.packageName?.trim() || PRIMARY_PACKAGE_NAME;
  const parts = packageName.split("/");
  const hasSafeSegments =
    parts.length > 0 &&
    parts.length <= 2 &&
    parts.every(
      (part) => part.length > 0 && part !== "." && part !== ".." && !part.includes("\\"),
    ) &&
    (parts.length === 1 || parts[0]?.startsWith("@"));
  return path.join(params.globalRoot, ...(hasSafeSegments ? parts : [PRIMARY_PACKAGE_NAME]));
}

function isDirectNpmNodeModulesRoot(globalRoot: string | null): boolean {
  return (
    globalRoot !== null &&
    resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot) === null &&
    resolveNpmGlobalPrefixLayoutFromGlobalRoot(globalRoot, {
      allowDirectNodeModulesRoot: true,
    }) !== null
  );
}

function inferBunGlobalRootFromPackageRoot(pkgRoot?: string | null): string | null {
  const directGlobalRoot = inferGlobalRootFromPackageRoot(pkgRoot);
  if (!directGlobalRoot) {
    return null;
  }
  return path.resolve(directGlobalRoot) === path.resolve(resolveBunGlobalRoot())
    ? directGlobalRoot
    : null;
}

function inferPnpmGlobalRootFromPackageRoot(pkgRoot?: string | null): string | null {
  const isolatedGlobalRoot = inferPnpmIsolatedGlobalRootFromPackageRoot(pkgRoot);
  if (isolatedGlobalRoot) {
    return isolatedGlobalRoot;
  }
  const directGlobalRoot = inferGlobalRootFromPackageRoot(pkgRoot);
  if (resolvePnpmGlobalDirFromGlobalRoot(directGlobalRoot)) {
    return directGlobalRoot;
  }

  const trimmed = pkgRoot?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.resolve(trimmed);
  const parts = normalized.split(path.sep);
  const pnpmIndex = parts.lastIndexOf(".pnpm");
  if (pnpmIndex <= 0) {
    return null;
  }
  if (parts[pnpmIndex + 2] !== "node_modules") {
    return null;
  }
  const layoutDir = parts.slice(0, pnpmIndex).join(path.sep) || path.sep;
  const globalRoot =
    path.basename(layoutDir) === "node_modules" ? layoutDir : path.join(layoutDir, "node_modules");
  return resolvePnpmGlobalDirFromGlobalRoot(globalRoot) ? globalRoot : null;
}

type PnpmIsolatedGlobalPackage = {
  globalRoot: string;
  packageRoot: string;
  layoutVersion: number;
  packageNames: string[];
};

function resolvePnpmIsolatedLayoutVersion(globalRoot?: string | null): number | null {
  const trimmed = globalRoot?.trim();
  const match = trimmed ? /^v(\d+)$/u.exec(path.basename(path.resolve(trimmed))) : null;
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

function inferPnpmIsolatedGlobalRootFromPackageRoot(pkgRoot?: string | null): string | null {
  const nodeModulesRoot = inferGlobalRootFromPackageRoot(pkgRoot);
  if (!nodeModulesRoot) {
    return null;
  }
  const globalRoot = path.dirname(path.dirname(nodeModulesRoot));
  return resolvePnpmIsolatedLayoutVersion(globalRoot) === null ? null : globalRoot;
}

async function hasPnpmIsolatedProjectMetadata(
  pkgRoot?: string | null,
  packageName = PRIMARY_PACKAGE_NAME,
): Promise<boolean> {
  if (!inferPnpmIsolatedGlobalRootFromPackageRoot(pkgRoot)) {
    return false;
  }
  const nodeModulesRoot = inferGlobalRootFromPackageRoot(pkgRoot);
  if (!nodeModulesRoot) {
    return false;
  }
  const installDir = path.dirname(nodeModulesRoot);
  const manifest = await fs
    .readFile(path.join(installDir, "package.json"), "utf8")
    .then((raw) => JSON.parse(raw) as { dependencies?: Record<string, unknown> })
    .catch(() => null);
  return Boolean(
    manifest?.dependencies &&
    packageName in manifest.dependencies &&
    (await pathExists(path.join(installDir, "pnpm-lock.yaml"))),
  );
}

/** Resolves the pnpm project owner without following its shared-store package symlink. */
export async function resolvePnpmIsolatedInstallOwner(
  pkgRoot?: string | null,
): Promise<string | null> {
  const nodeModulesRoot = inferGlobalRootFromPackageRoot(pkgRoot);
  if (!nodeModulesRoot) {
    return null;
  }
  return path.resolve(await tryRealpath(path.dirname(nodeModulesRoot)));
}

async function listPnpmIsolatedGlobalPackages(params: {
  globalRoot?: string | null;
  packageName?: string;
}): Promise<PnpmIsolatedGlobalPackage[]> {
  const globalRoot = params.globalRoot?.trim();
  const layoutVersion = resolvePnpmIsolatedLayoutVersion(globalRoot);
  if (!globalRoot || layoutVersion === null) {
    return [];
  }
  const packageName = params.packageName?.trim() || PRIMARY_PACKAGE_NAME;
  const entries = await fs.readdir(globalRoot, { withFileTypes: true }).catch(() => []);
  const packages: PnpmIsolatedGlobalPackage[] = [];

  // pnpm 11 marks active isolated projects with hash symlinks. Scan those
  // links, not install directories, so orphaned replacement roots stay ignored.
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const installDir = await fs.realpath(path.join(globalRoot, entry.name)).catch(() => null);
    if (!installDir) {
      continue;
    }
    const manifest = await fs
      .readFile(path.join(installDir, "package.json"), "utf8")
      .then((raw) => JSON.parse(raw) as { dependencies?: Record<string, unknown> })
      .catch(() => null);
    if (!manifest?.dependencies || !(packageName in manifest.dependencies)) {
      continue;
    }
    const packageRoot = resolvePackageRootFromGlobalRoot({
      globalRoot: path.join(installDir, "node_modules"),
      packageName,
    });
    if (await pathExists(packageRoot)) {
      packages.push({
        globalRoot: path.resolve(globalRoot),
        packageRoot,
        layoutVersion,
        packageNames: Object.keys(manifest.dependencies).toSorted((a, b) => a.localeCompare(b)),
      });
    }
  }
  return packages;
}

export async function listActivePnpmIsolatedGlobalPackages(params: {
  globalRoot?: string | null;
  packageName?: string;
}): Promise<Array<{ packageRoot: string; packageNames: string[] }>> {
  return (await listPnpmIsolatedGlobalPackages(params)).map((entry) => ({
    packageRoot: entry.packageRoot,
    packageNames: entry.packageNames,
  }));
}

async function resolvePnpmIsolatedGlobalPackage(params: {
  globalRoot?: string | null;
  packageName?: string;
  pkgRoot?: string | null;
}): Promise<PnpmIsolatedGlobalPackage | null> {
  const packages = await listPnpmIsolatedGlobalPackages(params);
  const requestedPackageRoot = params.pkgRoot ? path.resolve(params.pkgRoot) : null;
  const requestedOwnerRoot = inferPnpmIsolatedGlobalRootFromPackageRoot(params.pkgRoot);
  const globalRoot = params.globalRoot?.trim();
  const canonicalRequestedOwnerRoot = requestedOwnerRoot
    ? path.resolve(await tryRealpath(requestedOwnerRoot))
    : null;
  const canonicalGlobalRoot = globalRoot ? path.resolve(await tryRealpath(globalRoot)) : null;
  const canonicalOwnerMatches =
    canonicalRequestedOwnerRoot !== null && canonicalRequestedOwnerRoot === canonicalGlobalRoot;
  const requestedInstallOwner =
    requestedPackageRoot && canonicalOwnerMatches
      ? await resolvePnpmIsolatedInstallOwner(requestedPackageRoot)
      : null;

  for (const entry of packages) {
    const packageRoot = entry.packageRoot;
    if (requestedPackageRoot) {
      // Compare the isolated project owners, not the package symlinks: separate
      // pnpm 11 projects can point at the same shared-store package directory.
      const installOwner = await resolvePnpmIsolatedInstallOwner(packageRoot);
      if (requestedInstallOwner === null || installOwner !== requestedInstallOwner) {
        continue;
      }
    }
    return entry;
  }
  return null;
}

async function isPnpmIsolatedGlobalPackageRoot(pkgRoot?: string | null): Promise<boolean> {
  const globalRoot = inferPnpmIsolatedGlobalRootFromPackageRoot(pkgRoot);
  if (!globalRoot) {
    return false;
  }
  return Boolean(await resolvePnpmIsolatedGlobalPackage({ globalRoot, pkgRoot }));
}

/**
 * Resolves pnpm's global-dir from its active global package root.
 * pnpm 10 used `<globalDir>/<version>/node_modules`; pnpm 11 uses
 * `<globalDir>/v<version>` with isolated package projects below it.
 */
export function resolvePnpmGlobalDirFromGlobalRoot(globalRoot?: string | null): string | null {
  const trimmed = globalRoot?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.resolve(trimmed);
  if (/^v\d+$/u.test(path.basename(normalized))) {
    return path.dirname(normalized);
  }
  if (path.basename(normalized) !== "node_modules") {
    return null;
  }
  const layoutDir = path.dirname(normalized);
  return /^\d+$/u.test(path.basename(layoutDir)) ? path.dirname(layoutDir) : null;
}

async function isPnpmGlobalPackageRoot(pkgRoot?: string | null): Promise<boolean> {
  if (await isPnpmIsolatedGlobalPackageRoot(pkgRoot)) {
    return true;
  }
  if (await hasPnpmIsolatedProjectMetadata(pkgRoot)) {
    return true;
  }
  const globalRoot = inferPnpmGlobalRootFromPackageRoot(pkgRoot);
  if (!globalRoot) {
    return false;
  }
  const layoutDir = path.dirname(globalRoot);
  if (!(await pathExists(path.join(globalRoot, ".modules.yaml")))) {
    return false;
  }
  return (
    (await pathExists(path.join(layoutDir, "pnpm-lock.yaml"))) ||
    (await pathExists(path.join(layoutDir, "package.json")))
  );
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

/**
 * Resolves the package-manager command to execute for a global install.
 * npm may use the npm binary beside an existing package root when available.
 */
function resolveGlobalInstallCommand(
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

function resolveBunGlobalInstallSpec(spec: string): string {
  const trimmed = normalizePackageTarget(spec);
  if (normalizeLowercaseStringOrEmpty(trimmed).startsWith(`${PRIMARY_PACKAGE_NAME}@`)) {
    return trimmed;
  }
  const isWindowsAbsolutePath = /^[a-z]:[\\/]/iu.test(trimmed);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) && !isWindowsAbsolutePath;
  const target = /\.(?:tgz|tar\.gz)$/iu.test(trimmed) && !hasScheme ? `file:${trimmed}` : trimmed;
  // Bun needs an alias to replace the existing global dependency. A bare
  // tarball is added beside it and can form an openclaw dependency loop.
  return `${PRIMARY_PACKAGE_NAME}@${target}`;
}

function resolveInstallCommandForManager(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  manager: GlobalInstallManager,
  pkgRoot?: string | null,
): ResolvedGlobalInstallCommand {
  const normalized = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
  return normalized.manager === manager
    ? normalized
    : resolveGlobalInstallCommand(manager, pkgRoot);
}

/**
 * Reads the global `node_modules` root for a package manager command.
 * Bun uses its deterministic install root because it has no `root -g` command.
 */
async function resolveGlobalRoot(
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
  const root = readPackageManagerProbeValue(res.stdout);
  return root || null;
}

/**
 * Resolves the effective global install target, honoring an existing package
 * root when requested and detecting pnpm or bun layouts before command probes.
 */
export async function resolveGlobalInstallTarget(params: {
  manager: GlobalInstallManager | ResolvedGlobalInstallCommand;
  runCommand: CommandRunner;
  timeoutMs: number;
  pkgRoot?: string | null;
  honorPackageRoot?: boolean;
  packageName?: string;
}): Promise<ResolvedGlobalInstallTarget> {
  const requestedCommand = normalizeGlobalInstallCommand(params.manager, params.pkgRoot);
  const requestedPnpmGlobalRoot =
    requestedCommand.manager === "pnpm"
      ? await resolveGlobalRoot(
          requestedCommand,
          params.runCommand,
          params.timeoutMs,
          params.pkgRoot,
        )
      : null;
  const inferredPnpmIsolatedGlobalRoot = inferPnpmIsolatedGlobalRootFromPackageRoot(params.pkgRoot);
  const pnpmIsolatedPackage = inferredPnpmIsolatedGlobalRoot
    ? await resolvePnpmIsolatedGlobalPackage({
        globalRoot: inferredPnpmIsolatedGlobalRoot,
        packageName: params.packageName,
        pkgRoot: params.pkgRoot,
      })
    : await resolvePnpmIsolatedGlobalPackage({
        globalRoot: requestedPnpmGlobalRoot,
        packageName: params.packageName,
        pkgRoot: params.pkgRoot,
      });
  const hasPnpmIsolatedMetadata = pnpmIsolatedPackage
    ? true
    : await hasPnpmIsolatedProjectMetadata(params.pkgRoot, params.packageName);
  const verifiedPnpmIsolatedGlobalRoot =
    pnpmIsolatedPackage?.globalRoot ??
    (hasPnpmIsolatedMetadata ? inferredPnpmIsolatedGlobalRoot : null);
  const honoredPackageRootGlobalRoot = params.honorPackageRoot
    ? inferGlobalRootFromPackageRoot(params.pkgRoot)
    : null;
  const pnpmPackageRootGlobalRoot =
    verifiedPnpmIsolatedGlobalRoot || (await isPnpmGlobalPackageRoot(params.pkgRoot))
      ? inferPnpmGlobalRootFromPackageRoot(params.pkgRoot)
      : null;
  const bunPackageRootGlobalRoot = inferBunGlobalRootFromPackageRoot(params.pkgRoot);
  const honoredDirectNpmRoot =
    verifiedPnpmIsolatedGlobalRoot === null &&
    pnpmIsolatedPackage === null &&
    pnpmPackageRootGlobalRoot === null &&
    bunPackageRootGlobalRoot === null &&
    isDirectNpmNodeModulesRoot(honoredPackageRootGlobalRoot);
  const command = bunPackageRootGlobalRoot
    ? resolveInstallCommandForManager(params.manager, "bun", params.pkgRoot)
    : verifiedPnpmIsolatedGlobalRoot || pnpmPackageRootGlobalRoot
      ? resolveInstallCommandForManager(params.manager, "pnpm", params.pkgRoot)
      : honoredDirectNpmRoot
        ? resolveInstallCommandForManager(params.manager, "npm", params.pkgRoot)
        : normalizeGlobalInstallCommand(params.manager, params.pkgRoot);
  const globalRoot =
    requestedCommand.manager === "pnpm" &&
    command.manager === requestedCommand.manager &&
    command.command === requestedCommand.command
      ? requestedPnpmGlobalRoot
      : await resolveGlobalRoot(command, params.runCommand, params.timeoutMs, params.pkgRoot);
  const pkgRootGlobalRoot = command.manager === "pnpm" ? pnpmPackageRootGlobalRoot : null;
  // The detected npm owner applies to the running package, so its prefix is
  // authoritative. PATH's npm may belong to another Node installation and
  // report a different root, which would leave the running tree stale.
  const npmPackageRootGlobalRoot =
    command.manager === "npm" && inferNpmPrefixFromPackageRoot(params.pkgRoot)
      ? inferGlobalRootFromPackageRoot(params.pkgRoot)
      : null;
  const targetGlobalRoot =
    (command.manager === "bun" ? bunPackageRootGlobalRoot : null) ??
    (command.manager === "pnpm" ? verifiedPnpmIsolatedGlobalRoot : null) ??
    pkgRootGlobalRoot ??
    (command.manager === "npm" ? honoredPackageRootGlobalRoot : null) ??
    npmPackageRootGlobalRoot ??
    globalRoot;
  const pnpmIsolatedLayoutVersion =
    pnpmIsolatedPackage?.layoutVersion ??
    resolvePnpmIsolatedLayoutVersion(verifiedPnpmIsolatedGlobalRoot);
  const fallbackPackageRoot = targetGlobalRoot
    ? resolvePackageRootFromGlobalRoot({
        globalRoot: targetGlobalRoot,
        packageName: params.packageName,
      })
    : null;
  const packageRoot =
    command.manager === "pnpm"
      ? (pnpmIsolatedPackage?.packageRoot ??
        (verifiedPnpmIsolatedGlobalRoot && params.pkgRoot ? params.pkgRoot : fallbackPackageRoot))
      : fallbackPackageRoot;
  // Preserve metadata-backed pnpm ownership when the invoking project link is gone.
  // The update preflight must reject that orphan instead of falling through to npm.
  return {
    ...command,
    ...(command.manager === "pnpm" && pnpmIsolatedLayoutVersion !== null
      ? {
          pnpmIsolated: {
            layoutVersion: pnpmIsolatedLayoutVersion,
          },
        }
      : {}),
    globalRoot: targetGlobalRoot,
    packageRoot,
    ...(honoredPackageRootGlobalRoot &&
    targetGlobalRoot === honoredPackageRootGlobalRoot &&
    honoredDirectNpmRoot
      ? { directNodeModulesRoot: true }
      : {}),
  };
}

/**
 * Identifies which global package manager owns an existing package root.
 * Command probes are checked first, then pnpm/bun layout fingerprints.
 */
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
    const globalRoot = readPackageManagerProbeValue(res.stdout);
    if (!globalRoot) {
      continue;
    }
    const globalReal = await tryRealpath(globalRoot);
    if (manager === "pnpm") {
      for (const name of ALL_PACKAGE_NAMES) {
        if (await resolvePnpmIsolatedGlobalPackage({ globalRoot, packageName: name, pkgRoot })) {
          return "pnpm";
        }
      }
    }
    for (const name of ALL_PACKAGE_NAMES) {
      const expected = path.join(globalReal, name);
      const expectedReal = await tryRealpath(expected);
      if (path.resolve(expectedReal) === path.resolve(pkgReal)) {
        return manager;
      }
    }
  }

  if (await isPnpmGlobalPackageRoot(pkgRoot)) {
    return "pnpm";
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

  if (resolveNpmCommandBesidePackageRoot(pkgRoot)) {
    return "npm";
  }

  return null;
}

/**
 * Detects an installed global OpenClaw package by probing package-manager roots
 * when no trusted package root is already available.
 */
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

/**
 * Builds the primary package-manager argv for a global OpenClaw install.
 * npm receives quiet/freshness-bypass flags; pnpm and Bun approve OpenClaw's lifecycle.
 */
export function globalInstallArgs(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  spec: string,
  pkgRoot?: string | null,
  installPrefix?: string | null,
  installCwd?: string | null,
): string[] {
  const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
  if (resolved.manager === "pnpm") {
    return [
      resolved.command,
      "add",
      "-g",
      ...(installPrefix ? ["--global-dir", installPrefix] : []),
      ...(resolved.pnpmIsolated?.globalBinDir
        ? ["--global-bin-dir", resolved.pnpmIsolated.globalBinDir]
        : []),
      PNPM_OPENCLAW_BUILD_ALLOWLIST_FLAG,
      spec,
    ];
  }
  if (resolved.manager === "bun") {
    return [
      resolved.command,
      "add",
      "-g",
      BUN_OPENCLAW_TRUST_FLAG,
      resolveBunGlobalInstallSpec(spec),
    ];
  }
  return [
    resolved.command,
    "i",
    "-g",
    resolveNpmInstallScriptsAllowFlag(spec, installCwd),
    ...(installPrefix ? ["--prefix", installPrefix] : []),
    spec,
    ...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
    ...createNpmFreshnessBypassArgs(process.env, new Date(), {
      npmConfigPrefix: installPrefix,
    }),
  ];
}

/**
 * Builds npm's retry argv without optional dependencies.
 * Non-npm managers have no equivalent fallback and return null.
 */
export function globalInstallFallbackArgs(
  managerOrCommand: GlobalInstallManager | ResolvedGlobalInstallCommand,
  spec: string,
  pkgRoot?: string | null,
  installPrefix?: string | null,
  installCwd?: string | null,
): string[] | null {
  const resolved = normalizeGlobalInstallCommand(managerOrCommand, pkgRoot);
  if (resolved.manager !== "npm") {
    return null;
  }
  return [
    resolved.command,
    "i",
    "-g",
    resolveNpmInstallScriptsAllowFlag(spec, installCwd),
    ...(installPrefix ? ["--prefix", installPrefix] : []),
    spec,
    "--omit=optional",
    ...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
    ...createNpmFreshnessBypassArgs(process.env, new Date(), {
      npmConfigPrefix: installPrefix,
    }),
  ];
}

/** Removes leftover hidden global package directories from interrupted renames. */
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
  let entries: string[];
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
