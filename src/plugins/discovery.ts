/** Discovers plugin candidates from bundled, workspace, global, package, and bundle roots. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveIsNixMode } from "../config/paths.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import {
  hasUsableBundledPluginTree,
  resolveBundledPluginsDir,
  resolveSourceCheckoutDependencyDiagnostic,
} from "./bundled-dir.js";
import { buildLegacyBundledRootPath } from "./bundled-load-path-aliases.js";
import { listBundledSourceOverlayDirs } from "./bundled-source-overlays.js";
import {
  isPluginCandidateInstallOwnerAmbiguous,
  recordPluginCandidateInstallOwner,
  resolvePluginCandidateInstallOwner,
} from "./candidate-install-owner.js";
import type { PluginCandidate, PluginDiscoveryResult } from "./discovery.types.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { readLegacyNpmPluginDeclaration } from "./legacy-npm-declaration.js";
import type { PluginBundleFormat, PluginDiagnostic, PluginFormat } from "./manifest-types.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  loadPluginManifest,
  type PluginManifest,
  resolvePackageExtensionEntries,
  type OpenClawPackageManifest,
  type PackageExtensionResolution,
  type PackageManifest,
} from "./manifest.js";
import { satisfiesPluginApiRange, resolvePackagePluginApiRange } from "./package-compat.js";
import {
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
} from "./package-entry-resolution.js";
import { formatPosixMode, isPathInside } from "./path-safety.js";
import {
  parsePluginCacheJson,
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
  refreshPluginCacheStat,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import { getPluginCache } from "./plugin-cache.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePluginSourceRoots } from "./roots.js";
import { normalizePluginDependencySpecs } from "./status-dependencies-core.js";

export type { PluginCandidate, PluginDiscoveryResult } from "./discovery.types.js";

const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);
const SCANNED_DIRECTORY_IGNORE_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".yarn",
  ".yarn-cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
type PluginDiscoveryRootScope = "all" | "bundled";

function currentUid(overrideUid?: number | null): number | null {
  if (overrideUid !== undefined) {
    return overrideUid;
  }
  if (process.platform === "win32") {
    return null;
  }
  if (typeof process.getuid !== "function") {
    return null;
  }
  return process.getuid();
}

type CandidateBlockReason =
  | "source_escapes_root"
  | "path_stat_failed"
  | "path_world_writable"
  | "path_suspicious_ownership";

type CandidateBlockIssue = {
  reason: CandidateBlockReason;
  sourcePath: string;
  rootPath: string;
  targetPath: string;
  sourceRealPath?: string;
  rootRealPath?: string;
  modeBits?: number;
  foundUid?: number;
  expectedUid?: number;
};

function checkSourceEscapesRoot(params: {
  source: string;
  rootDir: string;
}): CandidateBlockIssue | null {
  const sourceRealPath = pluginCacheRealpathSync(params.source);
  const rootRealPath = pluginCacheRealpathSync(params.rootDir);
  if (!sourceRealPath || !rootRealPath) {
    return null;
  }
  if (isPathInside(rootRealPath, sourceRealPath)) {
    return null;
  }
  return {
    reason: "source_escapes_root",
    sourcePath: params.source,
    rootPath: params.rootDir,
    targetPath: params.source,
    sourceRealPath,
    rootRealPath,
  };
}

function checkPathStatAndPermissions(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  uid: number | null;
}): CandidateBlockIssue | null {
  if (process.platform === "win32") {
    return null;
  }
  const pathsToCheck = [params.rootDir, params.source];
  const seen = new Set<string>();
  for (const targetPath of pathsToCheck) {
    const normalized = path.resolve(targetPath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    let stat = pluginCacheStatSync(targetPath);
    if (!stat) {
      return {
        reason: "path_stat_failed",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
      };
    }
    let modeBits = stat.mode & 0o777;
    if ((modeBits & 0o002) !== 0 && params.origin === "bundled") {
      // npm/global installs can create package-managed extension dirs without
      // directory entries in the tarball, which may widen them to 0777.
      // Tighten bundled dirs in place before applying the normal safety gate.
      try {
        fs.chmodSync(targetPath, modeBits & ~0o022);
        const repairedStat = refreshPluginCacheStat(targetPath);
        if (!repairedStat) {
          return {
            reason: "path_stat_failed",
            sourcePath: params.source,
            rootPath: params.rootDir,
            targetPath,
          };
        }
        stat = repairedStat;
        modeBits = repairedStat.mode & 0o777;
      } catch {
        // Fall through to the normal block path below when repair is not possible.
      }
    }
    if ((modeBits & 0o002) !== 0) {
      return {
        reason: "path_world_writable",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        modeBits,
      };
    }
    if (
      params.origin !== "bundled" &&
      params.uid !== null &&
      typeof stat.uid === "number" &&
      stat.uid !== params.uid &&
      stat.uid !== 0
    ) {
      return {
        reason: "path_suspicious_ownership",
        sourcePath: params.source,
        rootPath: params.rootDir,
        targetPath,
        foundUid: stat.uid,
        expectedUid: params.uid,
      };
    }
  }
  return null;
}

function findCandidateBlockIssue(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
}): CandidateBlockIssue | null {
  const escaped = checkSourceEscapesRoot({
    source: params.source,
    rootDir: params.rootDir,
  });
  if (escaped) {
    return escaped;
  }
  return checkPathStatAndPermissions({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    uid: currentUid(params.ownershipUid),
  });
}

function formatCandidateBlockMessage(issue: CandidateBlockIssue): string {
  if (issue.reason === "source_escapes_root") {
    return `blocked plugin candidate: source escapes plugin root (${issue.sourcePath} -> ${issue.sourceRealPath}; root=${issue.rootRealPath})`;
  }
  if (issue.reason === "path_stat_failed") {
    return `blocked plugin candidate: cannot stat path (${issue.targetPath})`;
  }
  if (issue.reason === "path_world_writable") {
    return `blocked plugin candidate: world-writable path (${issue.targetPath}, mode=${formatPosixMode(issue.modeBits ?? 0)})`;
  }
  return `blocked plugin candidate: suspicious ownership (${issue.targetPath}, uid=${issue.foundUid}, expected uid=${issue.expectedUid} or root)`;
}

function isUnsafePluginCandidate(params: {
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  pluginId?: string;
  diagnostics: PluginDiagnostic[];
  ownershipUid?: number | null;
}): boolean {
  const issue = findCandidateBlockIssue({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    ownershipUid: params.ownershipUid,
  });
  if (!issue) {
    return false;
  }
  params.diagnostics.push({
    level: "warn",
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    source: issue.targetPath,
    message: formatCandidateBlockMessage(issue),
  });
  return true;
}

function isExtensionFile(filePath: string): boolean {
  const ext = path.extname(filePath);
  if (!EXTENSION_EXTS.has(ext)) {
    return false;
  }
  if (/\.d\.[cm]?ts$/.test(filePath)) {
    return false;
  }
  const baseName = normalizeLowercaseStringOrEmpty(path.basename(filePath));
  return (
    !baseName.includes(".test.") &&
    !baseName.includes(".live.test.") &&
    !baseName.includes(".e2e.test.")
  );
}

function shouldIgnoreScannedDirectory(dirName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(dirName);
  if (!normalized) {
    return true;
  }
  if (SCANNED_DIRECTORY_IGNORE_NAMES.has(normalized)) {
    return true;
  }
  if (normalized.endsWith(".bak")) {
    return true;
  }
  if (normalized.includes(".backup-")) {
    return true;
  }
  if (normalized.includes(".disabled")) {
    return true;
  }
  return false;
}

function resolveScannedEntryType(entry: fs.Dirent, fullPath: string): "file" | "directory" | null {
  if (entry.isFile()) {
    return "file";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (!entry.isSymbolicLink()) {
    return null;
  }

  const stat = pluginCacheStatSync(fullPath);
  if (!stat) {
    return null;
  }
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  return null;
}

function resolvesToSameDirectory(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const leftRealPath = pluginCacheRealpathSync(left);
  const rightRealPath = pluginCacheRealpathSync(right);
  if (leftRealPath && rightRealPath) {
    return leftRealPath === rightRealPath;
  }
  return path.resolve(left) === path.resolve(right);
}

function mergeCandidateInstallOwner(
  existing: PluginCandidate,
  candidateOwner: string | undefined,
  candidateOwnerAmbiguous: boolean,
): void {
  const existingOwner = resolvePluginCandidateInstallOwner(existing);
  const ownerConflict = existingOwner && candidateOwner && existingOwner !== candidateOwner;
  if (
    isPluginCandidateInstallOwnerAmbiguous(existing) ||
    candidateOwnerAmbiguous ||
    ownerConflict
  ) {
    recordPluginCandidateInstallOwner(existing, undefined, true);
  } else if (candidateOwner) {
    recordPluginCandidateInstallOwner(existing, candidateOwner);
  }
}

function addMissingRequiredPluginDiagnostics(
  result: PluginDiscoveryResult,
  params: { env: NodeJS.ProcessEnv },
): void {
  const candidateIds = new Set(result.candidates.map((candidate) => candidate.idHint));
  const seen = new Set<string>();
  let configuredFileManifestIds: Set<string> | undefined;
  for (const candidate of result.candidates) {
    for (const requiredPluginId of candidate.requiredPluginIds ?? []) {
      if (candidateIds.has(requiredPluginId) || requiredPluginId === candidate.idHint) {
        continue;
      }
      if (!configuredFileManifestIds) {
        configuredFileManifestIds = new Set();
        // Explicit files keep filename hints; only a validated root manifest
        // can establish their canonical identity for a missing dependency.
        for (const configuredCandidate of result.candidates) {
          if (configuredCandidate.origin !== "config" || configuredCandidate.packageDir) {
            continue;
          }
          const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
            origin: configuredCandidate.origin,
            rootDir: configuredCandidate.rootDir,
            env: params.env,
          });
          const manifest = resolveCandidateManifest(configuredCandidate.rootDir, rejectHardlinks);
          if (manifest) {
            configuredFileManifestIds.add(manifest.manifest.id);
          }
        }
      }
      if (configuredFileManifestIds.has(requiredPluginId)) {
        continue;
      }
      const key = `${candidate.idHint}\0${requiredPluginId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.diagnostics.push({
        level: "warn",
        pluginId: candidate.idHint,
        source: candidate.requiredPluginSource ?? candidate.source,
        message: `plugin "${candidate.idHint}" requires plugin "${requiredPluginId}"; install "${requiredPluginId}" to use it`,
      });
    }
  }
}

type InstalledPluginRecordPath = {
  path: string;
  requireBuiltRuntimeEntry: boolean;
  installOwner?: string;
  installOwnerAmbiguous?: true;
};

function prepareInstalledPluginPaths(
  installRecords: Record<string, PluginInstallRecord> | undefined,
  env: NodeJS.ProcessEnv,
  diagnostics: PluginDiagnostic[],
) {
  const byPath = new Map<string, InstalledPluginRecordPath>();
  const installedPluginDirKeys = new Set<string>();
  const managedPluginDirs = new Set<string>();
  const resolveRecordPath = (rawPath: string | undefined) =>
    typeof rawPath === "string" && rawPath.trim() ? resolveUserPath(rawPath, env) : undefined;
  for (const [installOwner, record] of Object.entries(installRecords ?? {})) {
    const installPath = resolveRecordPath(record.installPath);
    const sourcePath = resolveRecordPath(record.sourcePath);
    // Discovery follows the preferred install path, even when it is missing.
    // Both paths remain managed so a source copy cannot bypass built-entry checks.
    for (const recordedPath of [installPath, sourcePath]) {
      if (recordedPath && pluginCacheExistsSync(recordedPath)) {
        const key = resolveManagedPluginDirKey(recordedPath);
        if (key) {
          managedPluginDirs.add(key);
        }
      }
    }
    const resolved = installPath ?? sourcePath;
    if (!resolved || !pluginCacheExistsSync(resolved)) {
      continue;
    }
    const pathKey = pluginCacheRealpathSync(resolved) ?? path.resolve(resolved);
    const requireBuiltRuntimeEntry = !(
      record.source === "path" &&
      installPath &&
      sourcePath &&
      resolvesToSameDirectory(installPath, sourcePath)
    );
    const existing = byPath.get(pathKey);
    if (existing) {
      existing.requireBuiltRuntimeEntry ||= requireBuiltRuntimeEntry;
      if (existing.installOwner !== installOwner) {
        delete existing.installOwner;
        existing.installOwnerAmbiguous = true;
        diagnostics.push({
          level: "error",
          source: resolved,
          message:
            "multiple plugin install records claim the same package path; refresh or reinstall the package before using managed lifecycle actions",
        });
      }
    } else {
      byPath.set(pathKey, { path: resolved, requireBuiltRuntimeEntry, installOwner });
      // Only the retained entry was explicitly scanned. A discarded file alias's
      // parent may contain other plugins that still need global discovery.
      const dirKey = resolveManagedPluginDirKey(resolved);
      if (dirKey) {
        installedPluginDirKeys.add(dirKey);
      }
    }
  }
  return { installedPaths: [...byPath.values()], installedPluginDirKeys, managedPluginDirs };
}

function resolveManagedPluginDirKey(installedPath: string): string | null {
  const stat = pluginCacheStatSync(installedPath);
  if (!stat) {
    return null;
  }
  const pluginDir = stat.isFile() ? path.dirname(installedPath) : installedPath;
  return pluginCacheRealpathSync(pluginDir) ?? path.resolve(pluginDir);
}

function isManagedPluginDir(params: {
  dir: string;
  realpath?: string;
  managedPluginDirs?: Set<string>;
}): boolean {
  if (!params.managedPluginDirs || params.managedPluginDirs.size === 0) {
    return false;
  }
  const key = params.realpath ?? pluginCacheRealpathSync(params.dir) ?? path.resolve(params.dir);
  return params.managedPluginDirs.has(key);
}

function readPackageManifest(
  dir: string,
  rejectHardlinks = true,
  rootRealPath?: string,
): PackageManifest | null {
  const file = readPluginCacheFile({
    rootDir: dir,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    relativePath: "package.json",
    rejectHardlinks,
  });
  if (!file.ok) {
    return null;
  }
  const parsed = parsePluginCacheJson(file);
  return parsed.ok && isRecord(parsed.value) ? (parsed.value as PackageManifest) : null;
}

function readTrustedPackageManifest(dir: string): PackageManifest | null {
  return readPackageManifest(dir, false);
}

function readCandidatePackageManifest(params: {
  dir: string;
  origin: PluginOrigin;
  rejectHardlinks: boolean;
  rootRealPath?: string;
}): PackageManifest | null {
  return readPackageManifest(params.dir, params.rejectHardlinks, params.rootRealPath);
}

function deriveIdHint(params: {
  filePath: string;
  manifestId?: string;
  packageName?: string;
  fallbackId: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.filePath, path.extname(params.filePath));
  // Channel ids own transport diagnostics; package candidates retain their shipped plugin identity.
  const pluginId =
    normalizeOptionalString(params.manifestId) ??
    derivePackagePluginIdHint(params.packageName) ??
    params.fallbackId;
  return params.hasMultipleExtensions ? `${pluginId}/${base}` : pluginId;
}

function derivePackagePluginIdHint(packageName: unknown): string | undefined {
  const rawPackageName = normalizeOptionalString(packageName);
  if (!rawPackageName) {
    return undefined;
  }
  // Scoped package names must normalize to their unscoped runtime owner so
  // diagnostics, config keys, and discovered plugin identities cannot diverge.
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;
  for (const suffix of ["-provider", "-plugin"]) {
    if (unscoped.endsWith(suffix) && unscoped.length > suffix.length) {
      return unscoped.slice(0, -suffix.length);
    }
  }
  return normalizeOptionalString(unscoped);
}

function pushInvalidPackageExtensionDiagnostic(params: {
  resolution: PackageExtensionResolution;
  source: string;
  pluginId?: string;
  diagnostics: PluginDiagnostic[];
}): boolean {
  if (params.resolution.status === "invalid") {
    params.diagnostics.push({
      level: "error",
      source: params.source,
      message: params.resolution.error,
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    });
    return true;
  }
  if (params.resolution.status === "empty") {
    params.diagnostics.push({
      level: "error",
      source: params.source,
      message: "package.json openclaw.extensions is empty",
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    });
    return true;
  }
  return false;
}

type ResolvedCandidateManifest = {
  manifest: PluginManifest;
  manifestPath: string;
};

function resolveCandidateManifest(
  rootDir: string,
  rejectHardlinks: boolean,
  rootRealPath?: string,
): ResolvedCandidateManifest | undefined {
  const manifest = loadPluginManifest(rootDir, rejectHardlinks, rootRealPath);
  return manifest.ok
    ? { manifest: manifest.manifest, manifestPath: manifest.manifestPath }
    : undefined;
}

function addLegacyNpmDeclarationDiagnostic(params: {
  pluginDir: string;
  diagnostics: PluginDiagnostic[];
}): boolean {
  const declaration = readLegacyNpmPluginDeclaration(params.pluginDir);
  if (!declaration) {
    return false;
  }
  params.diagnostics.push({
    level: "warn",
    pluginId: declaration.pluginId,
    source: declaration.source,
    message: `legacy npm plugin declaration ignored for "${declaration.pluginId}"; run "openclaw doctor --fix" to install ${declaration.npmSpec} into the managed plugin root`,
  });
  return true;
}

function shouldSkipIncompatiblePackagePluginApi(params: {
  origin: PluginOrigin;
  packageManifest: OpenClawPackageManifest | undefined;
  pluginId: string;
  packageDir: string;
  env: NodeJS.ProcessEnv;
  diagnostics: PluginDiagnostic[];
}): boolean {
  if (params.origin === "bundled") {
    return false;
  }
  const packagePluginApiRangeCheck = resolvePackagePluginApiRange(params.packageManifest);
  if (!packagePluginApiRangeCheck.ok) {
    params.diagnostics.push({
      level: "warn",
      source: path.join(params.packageDir, "package.json"),
      message: `invalid package plugin API metadata: ${packagePluginApiRangeCheck.error}; skipping discovery (check package.json openclaw.compat.pluginApi)`,
      pluginId: params.pluginId,
    });
    return true;
  }
  const packagePluginApiRange = packagePluginApiRangeCheck.range;
  if (!packagePluginApiRange) {
    return false;
  }
  const compatibilityHostVersion = resolveCompatibilityHostVersion(params.env);
  if (satisfiesPluginApiRange(compatibilityHostVersion, packagePluginApiRange)) {
    return false;
  }
  params.diagnostics.push({
    level: "warn",
    source: path.join(params.packageDir, "package.json"),
    message: `plugin requires plugin API ${packagePluginApiRange}, but this host is ${compatibilityHostVersion}; skipping discovery (check "openclaw --version", OPENCLAW_COMPATIBILITY_HOST_VERSION, or run "openclaw doctor")`,
    pluginId: params.pluginId,
  });
  return true;
}

function isSourceCheckoutExtensionsDir(extensionsDir: string): boolean {
  const packageRoot = path.dirname(extensionsDir);
  return (
    pluginCacheExistsSync(path.join(packageRoot, ".git")) &&
    pluginCacheExistsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    pluginCacheExistsSync(path.join(packageRoot, "src")) &&
    hasUsableBundledPluginTree(extensionsDir)
  );
}

function resolveBundledSourceCheckoutExtensionsDir(bundledRoot?: string): string | undefined {
  if (!bundledRoot) {
    return undefined;
  }
  const legacyRoot = buildLegacyBundledRootPath(bundledRoot);
  if (!legacyRoot || !isSourceCheckoutExtensionsDir(legacyRoot)) {
    return undefined;
  }
  return legacyRoot;
}

// Host provenance is a fact about where a plugin lives, not how it was referenced.
// These are exactly the trees the bundled scan walks, so a configured alias of
// anything inside them is that same host-owned plugin and must classify identically.
function isHostBundledPluginRoot(dir: string, env: NodeJS.ProcessEnv): boolean {
  const bundledRoot = resolveBundledPluginsDir(env);
  const realDir = pluginCacheRealpathSync(dir) ?? path.resolve(dir);
  return [bundledRoot, resolveBundledSourceCheckoutExtensionsDir(bundledRoot)].some(
    (root) => root && isPathInside(pluginCacheRealpathSync(root) ?? path.resolve(root), realDir),
  );
}

function readChildDirectoryNames(dir: string | undefined): Set<string> {
  if (!dir || !pluginCacheExistsSync(dir)) {
    return new Set();
  }
  try {
    return new Set(
      sortUniqueStrings(
        readPluginCacheDirectory(dir)
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      ),
    );
  } catch {
    return new Set();
  }
}

function readBundledDistOptOutDirectoryNames(sourceExtensionsDir: string | undefined): Set<string> {
  const names = new Set<string>();
  if (!sourceExtensionsDir) {
    return names;
  }
  for (const name of readChildDirectoryNames(sourceExtensionsDir)) {
    const packageManifest = getPackageManifestMetadata(
      readTrustedPackageManifest(path.join(sourceExtensionsDir, name)) ?? undefined,
    );
    if (packageManifest?.build?.bundledDist === false) {
      names.add(name);
    }
  }
  return names;
}

type PluginDirectoryDiscoveryParams = {
  dir: string;
  rootRealPath: string | undefined;
  origin: PluginOrigin;
  workspaceDir?: string;
  installOwner?: string;
  installOwnerAmbiguous?: true;
  requireBuiltRuntimeEntry?: boolean;
  managedPluginDirs?: Set<string>;
};

function createPluginScanner(env: NodeJS.ProcessEnv, ownershipUid?: number | null) {
  const result: PluginDiscoveryResult = { candidates: [], diagnostics: [] };
  const { candidates, diagnostics } = result;
  // Rejected configured paths must still receive independent bundled validation.
  // Keep textual attempts phase-local; physical aliases merge only after acceptance.
  const attemptedSources = new Map<string, PluginCandidate | undefined>();

  function addCandidate(params: {
    idHint: string;
    effectivePluginId?: string;
    installOwner?: string;
    installOwnerAmbiguous?: true;
    diagnosticIdHint?: string;
    source: string;
    setupSource?: string;
    rootDir: string;
    origin: PluginOrigin;
    format?: PluginFormat;
    bundleFormat?: PluginBundleFormat;
    workspaceDir?: string;
    manifest?: PackageManifest | null;
    packageDir?: string;
    bundledManifestId?: string;
    bundledManifest?: PluginManifest;
    bundledManifestPath?: string;
    requiredPluginIds?: string[];
    requiredPluginSource?: string;
  }) {
    const resolved = path.resolve(params.source);
    if (attemptedSources.has(resolved)) {
      const existing = attemptedSources.get(resolved);
      if (existing) {
        mergeCandidateInstallOwner(
          existing,
          params.installOwner,
          params.installOwnerAmbiguous === true,
        );
      }
      return;
    }
    const resolvedRoot = pluginCacheRealpathSync(params.rootDir) ?? path.resolve(params.rootDir);
    if (
      isUnsafePluginCandidate({
        source: resolved,
        rootDir: resolvedRoot,
        origin: params.origin,
        pluginId: params.idHint,
        diagnostics,
        ownershipUid,
      })
    ) {
      attemptedSources.set(resolved, undefined);
      return;
    }
    const manifest = params.manifest ?? null;
    const packageManifest = getPackageManifestMetadata(manifest ?? undefined);
    const packageDependencies = normalizePluginDependencySpecs({
      dependencies: manifest?.dependencies,
      optionalDependencies: manifest?.optionalDependencies,
    });
    const candidate = {
      idHint: params.idHint,
      ...(params.effectivePluginId ? { effectivePluginId: params.effectivePluginId } : {}),
      ...(params.diagnosticIdHint && params.diagnosticIdHint !== params.idHint
        ? { diagnosticIdHint: params.diagnosticIdHint }
        : {}),
      source: resolved,
      setupSource: params.setupSource,
      rootDir: resolvedRoot,
      origin: params.origin,
      format: params.format ?? "openclaw",
      bundleFormat: params.bundleFormat,
      workspaceDir: params.workspaceDir,
      packageName: normalizeOptionalString(manifest?.name),
      packageVersion: normalizeOptionalString(manifest?.version),
      packageDescription: normalizeOptionalString(manifest?.description),
      packageDir: params.packageDir,
      packageManifest,
      packageDependencies: packageDependencies.dependencies,
      packageOptionalDependencies: packageDependencies.optionalDependencies,
      rawPackageManifest: manifest ?? undefined,
      bundledManifestId: params.bundledManifestId,
      bundledManifest: params.bundledManifest,
      bundledManifestPath: params.bundledManifestPath,
      ...(params.requiredPluginIds && params.requiredPluginIds.length > 0
        ? { requiredPluginIds: params.requiredPluginIds }
        : {}),
      ...(params.requiredPluginSource ? { requiredPluginSource: params.requiredPluginSource } : {}),
    } satisfies PluginCandidate;
    recordPluginCandidateInstallOwner(
      candidate,
      params.installOwner,
      params.installOwnerAmbiguous === true,
    );
    candidates.push(candidate);
    attemptedSources.set(resolved, candidate);
  }

  function discoverBundleInRoot(params: {
    rootDir: string;
    hasPackageExtensions: boolean;
    origin: PluginOrigin;
    workspaceDir?: string;
    installOwner?: string;
    installOwnerAmbiguous?: true;
    manifest?: PackageManifest | null;
  }): "added" | "invalid" | "none" {
    const bundleFormat = detectBundleManifestFormat(params.rootDir, params.hasPackageExtensions);
    if (!bundleFormat) {
      return "none";
    }
    const rootRealPath = pluginCacheRealpathSync(params.rootDir) ?? undefined;
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: params.origin,
      rootDir: params.rootDir,
      env,
    });
    const bundleManifest = loadBundleManifest({
      rootDir: params.rootDir,
      ...(rootRealPath !== undefined ? { rootRealPath } : {}),
      bundleFormat,
      rejectHardlinks,
    });
    if (!bundleManifest.ok) {
      diagnostics.push({
        level: "error",
        message: bundleManifest.error,
        source: bundleManifest.manifestPath,
      });
      return "invalid";
    }
    addCandidate({
      idHint: bundleManifest.manifest.id,
      source: params.rootDir,
      rootDir: params.rootDir,
      origin: params.origin,
      format: "bundle",
      bundleFormat,
      workspaceDir: params.workspaceDir,
      ...(params.installOwner ? { installOwner: params.installOwner } : {}),
      ...(params.installOwnerAmbiguous ? { installOwnerAmbiguous: true } : {}),
      manifest: params.manifest,
      packageDir: params.rootDir,
      bundledManifestId: bundleManifest.manifest.id,
      bundledManifestPath: bundleManifest.manifestPath,
    });
    return "added";
  }

  function discoverPluginDirectory(params: PluginDirectoryDiscoveryParams): boolean {
    const { dir, rootRealPath } = params;
    const requireBuiltRuntimeEntry =
      params.requireBuiltRuntimeEntry ??
      isManagedPluginDir({
        dir,
        realpath: rootRealPath,
        managedPluginDirs: params.managedPluginDirs,
      });
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: params.origin,
      rootDir: dir,
      env,
    });
    const manifest = readCandidatePackageManifest({
      dir,
      origin: params.origin,
      rejectHardlinks,
      ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    });
    const packageMetadata = getPackageManifestMetadata(manifest ?? undefined);
    // Compatibility can return early, so resolve one canonical diagnostic owner before every check.
    const candidateManifest = resolveCandidateManifest(dir, rejectHardlinks, rootRealPath);
    const manifestId = candidateManifest?.manifest.id;
    const pluginIdHint =
      normalizeOptionalString(manifestId) ??
      normalizeOptionalString(packageMetadata?.plugin?.id) ??
      normalizeOptionalString(packageMetadata?.channel?.id) ??
      derivePackagePluginIdHint(manifest?.name) ??
      path.basename(dir);
    if (
      shouldSkipIncompatiblePackagePluginApi({
        origin: params.origin,
        packageManifest: packageMetadata,
        pluginId: pluginIdHint,
        packageDir: dir,
        env,
        diagnostics,
      })
    ) {
      return true;
    }
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    if (
      pushInvalidPackageExtensionDiagnostic({
        resolution: extensionResolution,
        source: dir,
        pluginId: pluginIdHint,
        diagnostics,
      })
    ) {
      return true;
    }
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const setupSource = resolvePackageSetupSource({
      packageDir: dir,
      ...(rootRealPath !== undefined ? { packageRootRealPath: rootRealPath } : {}),
      manifest,
      pluginIdHint,
      origin: params.origin,
      requireBuiltRuntimeEntry,
      sourceLabel: dir,
      diagnostics,
      rejectHardlinks,
    });
    const addPackageCandidate = (
      source: string,
      idHint: string,
      effectivePluginId?: string,
    ): void => {
      addCandidate({
        idHint,
        ...(effectivePluginId ? { effectivePluginId } : {}),
        diagnosticIdHint: pluginIdHint,
        source,
        ...(setupSource ? { setupSource } : {}),
        rootDir: dir,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        ...(params.installOwner ? { installOwner: params.installOwner } : {}),
        ...(params.installOwnerAmbiguous ? { installOwnerAmbiguous: true } : {}),
        manifest,
        packageDir: dir,
        requiredPluginIds: candidateManifest?.manifest.requiresPlugins,
        requiredPluginSource: candidateManifest?.manifestPath,
      });
    };

    if (extensions.length > 0) {
      const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
        packageDir: dir,
        ...(rootRealPath !== undefined ? { packageRootRealPath: rootRealPath } : {}),
        manifest,
        extensions,
        origin: params.origin,
        pluginIdHint,
        requireBuiltRuntimeEntry,
        sourceLabel: dir,
        diagnostics,
        rejectHardlinks,
      });
      // Entry ids derive from basenames, so ./a/index.js and ./b/index.js would
      // both become <pack>/index and one entry would silently vanish in the
      // registry's same-id dedupe. Reject the colliding entries loudly instead.
      const entryIdSources = new Map<string, string[]>();
      for (const source of resolvedRuntimeSources) {
        const idHint = deriveIdHint({
          filePath: source,
          manifestId: manifestId ?? normalizeOptionalString(packageMetadata?.plugin?.id),
          packageName: manifest?.name,
          fallbackId: path.basename(dir),
          hasMultipleExtensions: extensions.length > 1,
        });
        const sources = entryIdSources.get(idHint);
        if (sources) {
          sources.push(source);
        } else {
          entryIdSources.set(idHint, [source]);
        }
      }
      for (const [idHint, sources] of entryIdSources) {
        if (extensions.length > 1 && sources.length > 1) {
          diagnostics.push({
            level: "error",
            pluginId: idHint,
            source: dir,
            message:
              `plugin package entries collide on derived id "${idHint}" ` +
              `(${sources.map((s) => path.relative(dir, s)).join(", ")}); ` +
              "rename the entry files to unique basenames",
          });
          continue;
        }
        for (const source of sources) {
          addPackageCandidate(source, idHint, extensions.length > 1 ? idHint : undefined);
        }
      }
      return true;
    }

    if (
      discoverBundleInRoot({
        rootDir: dir,
        hasPackageExtensions: extensions.length > 0,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        ...(params.installOwner ? { installOwner: params.installOwner } : {}),
        ...(params.installOwnerAmbiguous ? { installOwnerAmbiguous: true } : {}),
        manifest,
      }) === "added"
    ) {
      return true;
    }

    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(dir, candidate))
      .find((candidate) => pluginCacheExistsSync(candidate));
    if (indexFile && isExtensionFile(indexFile)) {
      addPackageCandidate(indexFile, manifestId ?? path.basename(dir));
      return true;
    }
    return addLegacyNpmDeclarationDiagnostic({ pluginDir: dir, diagnostics });
  }

  function discoverInDirectory(params: {
    dir: string;
    origin: PluginOrigin;
    workspaceDir?: string;
    installOwner?: string;
    installOwnerAmbiguous?: true;
    requireBuiltRuntimeEntry?: boolean;
    managedPluginDirs?: Set<string>;
    skipRootDirKeys?: Set<string>;
    scanFiles?: boolean;
    skipDirectories?: Set<string>;
  }) {
    if (!pluginCacheExistsSync(params.dir)) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = readPluginCacheDirectory(params.dir).toSorted((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    } catch (err) {
      diagnostics.push({
        level: "warn",
        message: `failed to read extensions dir: ${params.dir} (${String(err)})`,
        source: params.dir,
      });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(params.dir, entry.name);
      const entryType = resolveScannedEntryType(entry, fullPath);
      if (entryType === "file") {
        const shouldScanFile = params.scanFiles ?? params.origin === "bundled";
        if (!shouldScanFile || !isExtensionFile(fullPath)) {
          continue;
        }
        addCandidate({
          idHint: path.basename(entry.name, path.extname(entry.name)),
          source: fullPath,
          rootDir: path.dirname(fullPath),
          origin: params.origin,
          workspaceDir: params.workspaceDir,
          ...(params.installOwner ? { installOwner: params.installOwner } : {}),
          ...(params.installOwnerAmbiguous ? { installOwnerAmbiguous: true } : {}),
        });
        continue;
      }
      if (entryType !== "directory") {
        continue;
      }
      if (params.skipDirectories?.has(entry.name)) {
        continue;
      }
      if (shouldIgnoreScannedDirectory(entry.name)) {
        continue;
      }

      const fullPathRealPath = pluginCacheRealpathSync(fullPath) ?? undefined;
      const fullPathDirKey = fullPathRealPath ?? path.resolve(fullPath);
      if (
        params.origin === "bundled" &&
        !isPathInside(
          pluginCacheRealpathSync(params.dir) ?? path.resolve(params.dir),
          fullPathDirKey,
        )
      ) {
        diagnostics.push({
          level: "error",
          source: fullPath,
          message: `blocked plugin candidate: package directory escapes bundled root (${fullPath})`,
        });
        continue;
      }
      if (params.skipRootDirKeys?.has(fullPathDirKey)) {
        continue;
      }
      discoverPluginDirectory({
        ...params,
        dir: fullPath,
        rootRealPath: fullPathRealPath,
      });
    }
  }

  function discoverFromPath(params: {
    rawPath: string;
    origin: PluginOrigin;
    workspaceDir?: string;
    installOwner?: string;
    installOwnerAmbiguous?: true;
    requireBuiltRuntimeEntry?: boolean;
    managedPluginDirs?: Set<string>;
    skipRootDirKeys?: Set<string>;
    scanFiles?: boolean;
  }) {
    const resolved = resolveUserPath(params.rawPath, env);
    if (!pluginCacheExistsSync(resolved)) {
      diagnostics.push({
        level: "error",
        message: `plugin path not found: ${resolved}`,
        source: resolved,
      });
      return;
    }

    const stat = pluginCacheStatSync(resolved);
    if (!stat) {
      return;
    }
    // Origin gates entry resolution and bundled runtime privileges, so pointing
    // plugins.load.paths at a host-owned plugin must not reclassify it.
    const origin =
      params.origin === "config" &&
      isHostBundledPluginRoot(stat.isFile() ? path.dirname(resolved) : resolved, env)
        ? "bundled"
        : params.origin;
    if (stat.isFile()) {
      if (!isExtensionFile(resolved)) {
        diagnostics.push({
          level: "error",
          message: `plugin path is not a supported file: ${resolved}`,
          source: resolved,
        });
        return;
      }
      addCandidate({
        idHint: path.basename(resolved, path.extname(resolved)),
        source: resolved,
        rootDir: path.dirname(resolved),
        origin,
        workspaceDir: params.workspaceDir,
        ...(params.installOwner ? { installOwner: params.installOwner } : {}),
        ...(params.installOwnerAmbiguous ? { installOwnerAmbiguous: true } : {}),
      });
      return;
    }

    if (stat.isDirectory()) {
      if (
        discoverPluginDirectory({
          ...params,
          origin,
          dir: resolved,
          rootRealPath: pluginCacheRealpathSync(resolved) ?? undefined,
        })
      ) {
        return;
      }

      discoverInDirectory({
        dir: resolved,
        origin,
        workspaceDir: params.workspaceDir,
        ...(params.scanFiles !== undefined || params.origin === "config"
          ? { scanFiles: params.scanFiles ?? true }
          : {}),
        ...(params.requireBuiltRuntimeEntry !== undefined
          ? { requireBuiltRuntimeEntry: params.requireBuiltRuntimeEntry }
          : {}),
        ...(params.managedPluginDirs ? { managedPluginDirs: params.managedPluginDirs } : {}),
        ...(params.skipRootDirKeys ? { skipRootDirKeys: params.skipRootDirKeys } : {}),
      });
    }
  }

  function discoverConfiguredPaths(loadPaths: readonly string[], workspaceDir?: string): void {
    const firstConfigured = candidates.length;
    for (const loadPath of loadPaths) {
      if (typeof loadPath === "string" && loadPath.trim()) {
        discoverFromPath({ rawPath: loadPath.trim(), origin: "config", workspaceDir });
      }
    }
    // Explicit operator selection is its own fact: host-owned aliases keep bundled
    // origin, so duplicate precedence must not read selection off `origin` alone.
    for (const candidate of candidates.slice(firstConfigured)) {
      candidate.configSelected = true;
    }
  }
  function finish(): PluginDiscoveryResult {
    const candidatesBySource = new Map<string, PluginCandidate>();
    const seenDiagnostics = new Set<string>();
    const uniqueDiagnostics: PluginDiagnostic[] = [];
    for (const candidate of candidates) {
      // Only an independently accepted bundled candidate can establish bundled
      // provenance. A configured alias must not downgrade that same physical entry.
      const key = pluginCacheRealpathSync(candidate.source) ?? path.resolve(candidate.source);
      const existing = candidatesBySource.get(key);
      if (existing) {
        const retained = candidate.origin === "bundled" ? candidate : existing;
        const duplicate = retained === candidate ? existing : candidate;
        if (duplicate.origin === "config" || duplicate.configSelected) {
          retained.configSelected = true;
        }
        if (duplicate.sourcePreferred) {
          retained.sourcePreferred = true;
        }
        mergeCandidateInstallOwner(
          retained,
          resolvePluginCandidateInstallOwner(duplicate),
          isPluginCandidateInstallOwnerAmbiguous(duplicate),
        );
        candidatesBySource.set(key, retained);
        continue;
      }
      candidatesBySource.set(key, candidate);
    }
    for (const diagnostic of diagnostics) {
      const key = [
        diagnostic.level,
        diagnostic.pluginId ?? "",
        diagnostic.source ?? "",
        diagnostic.message,
      ].join("\0");
      if (seenDiagnostics.has(key)) {
        continue;
      }
      seenDiagnostics.add(key);
      uniqueDiagnostics.push(diagnostic);
    }

    result.candidates = [...candidatesBySource.values()];
    result.diagnostics = uniqueDiagnostics;
    return result;
  }
  return {
    result,
    discoverConfiguredPaths,
    discoverFromPath,
    discoverInDirectory,
    finish,
    startSharedPhase: () => attemptedSources.clear(),
  };
}

function discoveryPolicy(env: NodeJS.ProcessEnv, ownershipUid: number | null | undefined) {
  return {
    ownershipUid: currentUid(ownershipUid),
    compatibilityHostVersion: resolveCompatibilityHostVersion(env),
    // Configured-path classification depends on the host's bundled tree.
    bundledRoot: resolveBundledPluginsDir(env) ?? "",
    nix: resolveIsNixMode(env),
    sourceOverlaysDisabled: env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS ?? "",
    home: env.OPENCLAW_HOME ?? "",
    userHome: env.HOME ?? "",
    userProfile: env.USERPROFILE ?? "",
    cwd: process.cwd(),
  };
}

/** Discovers only explicit plugins.load.paths candidates without scanning shared roots. */
export function discoverConfiguredPluginLoadPaths(params: {
  loadPaths: readonly string[];
  deduplicate?: boolean;
  workspaceDir?: string;
  ownershipUid?: number | null;
  env?: NodeJS.ProcessEnv;
}): PluginDiscoveryResult {
  const env = params.env ?? process.env;
  const cache = getPluginCache().metadata.discovery;
  const key = hashStableJson({
    phase: params.deduplicate ? "configured-published" : "configured-raw",
    loadPaths: params.loadPaths,
    workspaceDir: params.workspaceDir,
    policy: discoveryPolicy(env, params.ownershipUid),
  });
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const scanner = createPluginScanner(env, params.ownershipUid);
  scanner.discoverConfiguredPaths(params.loadPaths, normalizeOptionalString(params.workspaceDir));
  // Doctor needs raw alias counts and diagnostics, not the full scan's publication pass.
  const result = params.deduplicate ? scanner.finish() : scanner.result;
  cache.set(key, result);
  return result;
}

export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  installRecords?: Record<string, PluginInstallRecord>;
  ownershipUid?: number | null;
  env?: NodeJS.ProcessEnv;
  rootScope?: PluginDiscoveryRootScope;
}): PluginDiscoveryResult {
  const env = params.env ?? process.env;
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : undefined;
  const roots = resolvePluginSourceRoots({ workspaceDir: workspaceRoot, env });
  const cache = getPluginCache().metadata.discovery;
  const key = hashStableJson({
    phase: "all",
    roots,
    workspaceDir,
    loadPaths: params.extraPaths ?? [],
    // Install order determines which physical alias is retained during discovery.
    installRecords: Object.entries(params.installRecords ?? {}),
    rootScope: params.rootScope ?? "all",
    policy: discoveryPolicy(env, params.ownershipUid),
  });
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const scanner = createPluginScanner(env, params.ownershipUid);
  const { result, discoverFromPath, discoverInDirectory } = scanner;
  if (params.rootScope !== "bundled") {
    tracePluginLifecyclePhase(
      "discovery scan",
      () => {
        scanner.discoverConfiguredPaths(params.extraPaths ?? [], workspaceDir);
        const workspaceMatchesBundledRoot = resolvesToSameDirectory(workspaceRoot, roots.stock);
        if (roots.workspace && workspaceRoot && !workspaceMatchesBundledRoot) {
          // Keep workspace auto-discovery constrained to the OpenClaw extensions root.
          // Recursively scanning the full workspace treats arbitrary project folders as
          // plugin candidates and causes noisy "plugin manifest not found" validation failures.
          discoverInDirectory({
            dir: roots.workspace,
            origin: "workspace",
            workspaceDir: workspaceRoot,
          });
        }
      },
      { scope: "scoped", extraPathCount: params.extraPaths?.length ?? 0 },
    );
  }
  scanner.startSharedPhase();
  tracePluginLifecyclePhase(
    "discovery scan",
    () => {
      for (const sourceOverlayDir of listBundledSourceOverlayDirs({
        bundledRoot: roots.stock,
        env,
      })) {
        const firstOverlay = result.candidates.length;
        discoverFromPath({
          rawPath: sourceOverlayDir,
          origin: "bundled",
          workspaceDir,
        });
        for (const candidate of result.candidates.slice(firstOverlay)) {
          candidate.sourcePreferred = true;
        }
        result.diagnostics.push({
          level: "warn",
          source: sourceOverlayDir,
          message:
            "using bind-mounted bundled plugin source overlay; this source overrides the packaged dist bundle for the same plugin id",
        });
      }
      const sourceCheckoutDependencyDiagnostic = resolveSourceCheckoutDependencyDiagnostic(env);
      if (sourceCheckoutDependencyDiagnostic) {
        result.diagnostics.push({
          level: "warn",
          source: sourceCheckoutDependencyDiagnostic.source,
          message: sourceCheckoutDependencyDiagnostic.message,
        });
      }
      const sourceCheckoutExtensionsDir = resolveBundledSourceCheckoutExtensionsDir(roots.stock);
      const bundledDistOptOutDirectories = readBundledDistOptOutDirectoryNames(
        sourceCheckoutExtensionsDir,
      );
      if (sourceCheckoutExtensionsDir) {
        for (const dirName of bundledDistOptOutDirectories) {
          discoverFromPath({
            rawPath: path.join(sourceCheckoutExtensionsDir, dirName),
            origin: "bundled",
            workspaceDir,
          });
        }
      }
      if (roots.stock) {
        discoverInDirectory({
          dir: roots.stock,
          origin: "bundled",
          skipDirectories: bundledDistOptOutDirectories,
        });
      }
      const sourceCheckoutMatchesBundledRoot = resolvesToSameDirectory(
        sourceCheckoutExtensionsDir,
        roots.stock,
      );
      if (sourceCheckoutExtensionsDir && !sourceCheckoutMatchesBundledRoot) {
        discoverInDirectory({
          dir: sourceCheckoutExtensionsDir,
          origin: "bundled",
          skipDirectories: readChildDirectoryNames(roots.stock),
        });
      }
      if (params.rootScope !== "bundled") {
        const { installedPaths, installedPluginDirKeys, managedPluginDirs } =
          prepareInstalledPluginPaths(params.installRecords, env, result.diagnostics);
        for (const installedPath of installedPaths) {
          discoverFromPath({
            rawPath: installedPath.path,
            origin: "global",
            workspaceDir,
            ...(installedPath.installOwner ? { installOwner: installedPath.installOwner } : {}),
            ...(installedPath.installOwnerAmbiguous ? { installOwnerAmbiguous: true } : {}),
            requireBuiltRuntimeEntry: installedPath.requireBuiltRuntimeEntry,
            managedPluginDirs,
            scanFiles: true,
          });
        }
        // Keep auto-discovered global extensions behind bundled plugins.
        // Users can still intentionally override via plugins.load.paths (origin=config).
        discoverInDirectory({
          dir: roots.global,
          origin: "global",
          managedPluginDirs,
          skipRootDirKeys: installedPluginDirKeys,
        });
      }
    },
    { scope: "shared" },
  );
  scanner.finish();
  addMissingRequiredPluginDiagnostics(result, { env });
  cache.set(key, result);
  return result;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
