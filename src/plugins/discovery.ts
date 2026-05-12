import fs from "node:fs";
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { tryReadJsonSync } from "../infra/json-files.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { resolveSourceCheckoutDependencyDiagnostic } from "./bundled-dir.js";
import {
  buildLegacyBundledRootPath,
  resolvePackagedBundledLoadPathAlias,
} from "./bundled-load-path-aliases.js";
import { listBundledSourceOverlayDirs } from "./bundled-source-overlays.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import type { PluginBundleFormat, PluginDiagnostic, PluginFormat } from "./manifest-types.js";
import {
  DEFAULT_PLUGIN_ENTRY_CANDIDATES,
  getPackageManifestMetadata,
  loadPluginManifest,
  type PluginManifest,
  resolvePackageExtensionEntries,
  type OpenClawPackageManifest,
  type PackageManifest,
} from "./manifest.js";
import {
  resolvePackageRuntimeExtensionSources,
  resolvePackageSetupSource,
} from "./package-entry-resolution.js";
import { formatPosixMode, isPathInside, safeRealpathSync, safeStatSync } from "./path-safety.js";
import { tracePluginLifecyclePhase } from "./plugin-lifecycle-trace.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePluginSourceRoots } from "./roots.js";
import {
  normalizePluginDependencySpecs,
  type PluginDependencySpecMap,
} from "./status-dependencies.js";

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

export type PluginCandidate = {
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  workspaceDir?: string;
  packageName?: string;
  packageVersion?: string;
  packageDescription?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
  packageDependencies?: PluginDependencySpecMap;
  packageOptionalDependencies?: PluginDependencySpecMap;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
};

export type PluginDiscoveryResult = {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
};

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

export type CandidateBlockReason =
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
  realpathCache: Map<string, string>;
}): CandidateBlockIssue | null {
  const sourceRealPath = safeRealpathSync(params.source, params.realpathCache);
  const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache);
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
    let stat = safeStatSync(targetPath);
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
        const repairedStat = safeStatSync(targetPath);
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
  realpathCache: Map<string, string>;
}): CandidateBlockIssue | null {
  const escaped = checkSourceEscapesRoot({
    source: params.source,
    rootDir: params.rootDir,
    realpathCache: params.realpathCache,
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
  realpathCache: Map<string, string>;
}): boolean {
  const issue = findCandidateBlockIssue({
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    ownershipUid: params.ownershipUid,
    realpathCache: params.realpathCache,
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
  if (filePath.endsWith(".d.ts")) {
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

  const stat = safeStatSync(fullPath);
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

function resolvesToSameDirectory(
  left: string | undefined,
  right: string | undefined,
  realpathCache: Map<string, string>,
): boolean {
  if (!left || !right) {
    return false;
  }
  const leftRealPath = safeRealpathSync(left, realpathCache);
  const rightRealPath = safeRealpathSync(right, realpathCache);
  if (leftRealPath && rightRealPath) {
    return leftRealPath === rightRealPath;
  }
  return path.resolve(left) === path.resolve(right);
}

function createDiscoveryResult(): PluginDiscoveryResult {
  return {
    candidates: [],
    diagnostics: [],
  };
}

function mergeDiscoveryResult(
  target: PluginDiscoveryResult,
  source: PluginDiscoveryResult,
  seenSources: Set<string>,
  seenDiagnostics: Set<string>,
): void {
  for (const candidate of source.candidates) {
    const key = candidate.source;
    if (seenSources.has(key)) {
      continue;
    }
    seenSources.add(key);
    target.candidates.push(candidate);
  }
  for (const diagnostic of source.diagnostics) {
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
    target.diagnostics.push(diagnostic);
  }
}

function collectInstalledPluginRecordPaths(
  installRecords: Record<string, PluginInstallRecord> | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const record of Object.values(installRecords ?? {})) {
    const rawPath =
      typeof record.installPath === "string" && record.installPath.trim()
        ? record.installPath
        : typeof record.sourcePath === "string" && record.sourcePath.trim()
          ? record.sourcePath
          : undefined;
    if (!rawPath) {
      continue;
    }
    const resolved = resolveUserPath(rawPath, env);
    if (seen.has(resolved) || !fs.existsSync(resolved)) {
      continue;
    }
    seen.add(resolved);
    paths.push(resolved);
  }
  return paths;
}

// Discovery follows the install ledger's primary path choice; managed
// classification needs every recorded path so a sourcePath under the global
// extensions root does not get rescanned as an untracked local plugin.
function collectManagedPluginRecordPaths(
  installRecords: Record<string, PluginInstallRecord> | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const record of Object.values(installRecords ?? {})) {
    for (const rawPath of [record.installPath, record.sourcePath]) {
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        continue;
      }
      const resolved = resolveUserPath(rawPath, env);
      if (seen.has(resolved) || !fs.existsSync(resolved)) {
        continue;
      }
      seen.add(resolved);
      paths.push(resolved);
    }
  }
  return paths;
}

function resolveManagedPluginDirKey(
  installedPath: string,
  realpathCache: Map<string, string>,
): string | null {
  const stat = safeStatSync(installedPath);
  if (!stat) {
    return null;
  }
  const pluginDir = stat.isFile() ? path.dirname(installedPath) : installedPath;
  return safeRealpathSync(pluginDir, realpathCache) ?? path.resolve(pluginDir);
}

function collectManagedPluginDirKeys(
  installedPaths: readonly string[],
  realpathCache: Map<string, string>,
): Set<string> {
  const dirs = new Set<string>();
  for (const installedPath of installedPaths) {
    const key = resolveManagedPluginDirKey(installedPath, realpathCache);
    if (key) {
      dirs.add(key);
    }
  }
  return dirs;
}

function isManagedPluginDir(params: {
  dir: string;
  realpath?: string;
  managedPluginDirs?: Set<string>;
  realpathCache: Map<string, string>;
}): boolean {
  if (!params.managedPluginDirs || params.managedPluginDirs.size === 0) {
    return false;
  }
  const key =
    params.realpath ??
    safeRealpathSync(params.dir, params.realpathCache) ??
    path.resolve(params.dir);
  return params.managedPluginDirs.has(key);
}

function readPackageManifest(
  dir: string,
  rejectHardlinks = true,
  rootRealPath?: string,
): PackageManifest | null {
  const result = readRootJsonObjectSync({
    rootDir: dir,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    relativePath: "package.json",
    boundaryLabel: "plugin package directory",
    rejectHardlinks,
  });
  return result.ok ? (result.value as PackageManifest) : null;
}

function readTrustedPackageManifest(dir: string): PackageManifest | null {
  return tryReadJsonSync<PackageManifest>(path.join(dir, "package.json"));
}

function readCandidatePackageManifest(params: {
  dir: string;
  origin: PluginOrigin;
  rejectHardlinks: boolean;
  rootRealPath?: string;
}): PackageManifest | null {
  if (params.origin === "bundled") {
    return readTrustedPackageManifest(params.dir);
  }
  return readPackageManifest(params.dir, params.rejectHardlinks, params.rootRealPath);
}

function deriveIdHint(params: {
  filePath: string;
  manifestId?: string;
  packageName?: string;
  hasMultipleExtensions: boolean;
}): string {
  const base = path.basename(params.filePath, path.extname(params.filePath));
  const rawManifestId = params.manifestId?.trim();
  if (rawManifestId) {
    return params.hasMultipleExtensions ? `${rawManifestId}/${base}` : rawManifestId;
  }
  const rawPackageName = params.packageName?.trim();
  if (!rawPackageName) {
    return base;
  }

  // Prefer the unscoped name so config keys stay stable even when the npm
  // package is scoped (example: @openclaw/voice-call -> voice-call).
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;
  const normalizedPackageId =
    unscoped.endsWith("-provider") && unscoped.length > "-provider".length
      ? unscoped.slice(0, -"-provider".length)
      : unscoped;

  if (!params.hasMultipleExtensions) {
    return normalizedPackageId;
  }
  return `${normalizedPackageId}/${base}`;
}

function derivePackagePluginIdHint(params: {
  manifestId?: string;
  packageName?: string;
}): string | undefined {
  const rawManifestId = params.manifestId?.trim();
  if (rawManifestId) {
    return rawManifestId;
  }
  const rawPackageName = params.packageName?.trim();
  if (!rawPackageName) {
    return undefined;
  }
  const unscoped = rawPackageName.includes("/")
    ? (rawPackageName.split("/").pop() ?? rawPackageName)
    : rawPackageName;
  return unscoped.endsWith("-provider") && unscoped.length > "-provider".length
    ? unscoped.slice(0, -"-provider".length)
    : unscoped;
}

function resolveIdHintManifestId(
  rootDir: string,
  rejectHardlinks: boolean,
  rootRealPath?: string,
): string | undefined {
  const manifest = loadPluginManifest(rootDir, rejectHardlinks, rootRealPath);
  return manifest.ok ? manifest.manifest.id : undefined;
}

function addCandidate(params: {
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  idHint: string;
  source: string;
  setupSource?: string;
  rootDir: string;
  origin: PluginOrigin;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  ownershipUid?: number | null;
  workspaceDir?: string;
  manifest?: PackageManifest | null;
  packageDir?: string;
  bundledManifest?: PluginManifest;
  bundledManifestPath?: string;
  realpathCache: Map<string, string>;
}) {
  const resolved = path.resolve(params.source);
  if (params.seen.has(resolved)) {
    return;
  }
  const resolvedRoot =
    safeRealpathSync(params.rootDir, params.realpathCache) ?? path.resolve(params.rootDir);
  if (
    isUnsafePluginCandidate({
      source: resolved,
      rootDir: resolvedRoot,
      origin: params.origin,
      pluginId: params.idHint,
      diagnostics: params.diagnostics,
      ownershipUid: params.ownershipUid,
      realpathCache: params.realpathCache,
    })
  ) {
    params.seen.add(resolved);
    return;
  }
  params.seen.add(resolved);
  const manifest = params.manifest ?? null;
  const packageDependencies = normalizePluginDependencySpecs({
    dependencies: manifest?.dependencies,
    optionalDependencies: manifest?.optionalDependencies,
  });
  params.candidates.push({
    idHint: params.idHint,
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
    packageManifest: getPackageManifestMetadata(manifest ?? undefined),
    packageDependencies: packageDependencies.dependencies,
    packageOptionalDependencies: packageDependencies.optionalDependencies,
    bundledManifest: params.bundledManifest,
    bundledManifestPath: params.bundledManifestPath,
  });
}

function discoverBundleInRoot(params: {
  rootDir: string;
  origin: PluginOrigin;
  env: NodeJS.ProcessEnv;
  ownershipUid?: number | null;
  workspaceDir?: string;
  manifest?: PackageManifest | null;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  realpathCache: Map<string, string>;
}): "added" | "invalid" | "none" {
  const bundleFormat = detectBundleManifestFormat(params.rootDir);
  if (!bundleFormat) {
    return "none";
  }
  const rootRealPath = safeRealpathSync(params.rootDir, params.realpathCache) ?? undefined;
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: params.origin,
    rootDir: params.rootDir,
    env: params.env,
    realpathCache: params.realpathCache,
  });
  const bundleManifest = loadBundleManifest({
    rootDir: params.rootDir,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    bundleFormat,
    rejectHardlinks,
  });
  if (!bundleManifest.ok) {
    params.diagnostics.push({
      level: "error",
      message: bundleManifest.error,
      source: bundleManifest.manifestPath,
    });
    return "invalid";
  }
  addCandidate({
    candidates: params.candidates,
    diagnostics: params.diagnostics,
    seen: params.seen,
    idHint: bundleManifest.manifest.id,
    source: params.rootDir,
    rootDir: params.rootDir,
    origin: params.origin,
    format: "bundle",
    bundleFormat,
    ownershipUid: params.ownershipUid,
    workspaceDir: params.workspaceDir,
    manifest: params.manifest,
    packageDir: params.rootDir,
    realpathCache: params.realpathCache,
  });
  return "added";
}

function discoverInDirectory(params: {
  dir: string;
  origin: PluginOrigin;
  env: NodeJS.ProcessEnv;
  ownershipUid?: number | null;
  workspaceDir?: string;
  requireBuiltRuntimeEntry?: boolean;
  managedPluginDirs?: Set<string>;
  skipRootDirKeys?: Set<string>;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  realpathCache: Map<string, string>;
  recurseDirectories?: boolean;
  skipDirectories?: Set<string>;
  visitedDirectories?: Set<string>;
}) {
  if (!fs.existsSync(params.dir)) {
    return;
  }
  const resolvedDir =
    safeRealpathSync(params.dir, params.realpathCache) ?? path.resolve(params.dir);
  if (params.recurseDirectories) {
    if (params.visitedDirectories?.has(resolvedDir)) {
      return;
    }
    params.visitedDirectories?.add(resolvedDir);
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(params.dir, { withFileTypes: true });
  } catch (err) {
    params.diagnostics.push({
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
      if (!isExtensionFile(fullPath)) {
        continue;
      }
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: path.basename(entry.name, path.extname(entry.name)),
        source: fullPath,
        rootDir: path.dirname(fullPath),
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        realpathCache: params.realpathCache,
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

    const fullPathRealPath = safeRealpathSync(fullPath, params.realpathCache) ?? undefined;
    const fullPathDirKey = fullPathRealPath ?? path.resolve(fullPath);
    if (params.skipRootDirKeys?.has(fullPathDirKey)) {
      continue;
    }
    const requireBuiltRuntimeEntry =
      params.requireBuiltRuntimeEntry ??
      isManagedPluginDir({
        dir: fullPath,
        realpath: fullPathRealPath,
        managedPluginDirs: params.managedPluginDirs,
        realpathCache: params.realpathCache,
      });
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: params.origin,
      rootDir: fullPath,
      env: params.env,
      realpathCache: params.realpathCache,
    });
    const manifest = readCandidatePackageManifest({
      dir: fullPath,
      origin: params.origin,
      rejectHardlinks,
      ...(fullPathRealPath !== undefined ? { rootRealPath: fullPathRealPath } : {}),
    });
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const manifestId = resolveIdHintManifestId(fullPath, rejectHardlinks, fullPathRealPath);
    const setupSource = resolvePackageSetupSource({
      packageDir: fullPath,
      ...(fullPathRealPath !== undefined ? { packageRootRealPath: fullPathRealPath } : {}),
      manifest,
      origin: params.origin,
      requireBuiltRuntimeEntry,
      sourceLabel: fullPath,
      diagnostics: params.diagnostics,
      rejectHardlinks,
    });

    if (extensions.length > 0) {
      const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
        packageDir: fullPath,
        ...(fullPathRealPath !== undefined ? { packageRootRealPath: fullPathRealPath } : {}),
        manifest,
        extensions,
        origin: params.origin,
        pluginIdHint: derivePackagePluginIdHint({ manifestId, packageName: manifest?.name }),
        requireBuiltRuntimeEntry,
        sourceLabel: fullPath,
        diagnostics: params.diagnostics,
        rejectHardlinks,
      });
      for (const resolved of resolvedRuntimeSources) {
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: resolved,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source: resolved,
          ...(setupSource ? { setupSource } : {}),
          rootDir: fullPath,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: fullPath,
          realpathCache: params.realpathCache,
        });
      }
      continue;
    }

    const bundleDiscovery = discoverBundleInRoot({
      rootDir: fullPath,
      origin: params.origin,
      env: params.env,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      manifest,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      realpathCache: params.realpathCache,
    });
    if (bundleDiscovery === "added") {
      continue;
    }

    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(fullPath, candidate))
      .find((candidate) => fs.existsSync(candidate));
    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: manifestId ?? entry.name,
        source: indexFile,
        ...(setupSource ? { setupSource } : {}),
        rootDir: fullPath,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: fullPath,
        realpathCache: params.realpathCache,
      });
      continue;
    }

    if (params.recurseDirectories) {
      discoverInDirectory({
        ...params,
        dir: fullPath,
      });
    }
  }
}

function hasDiscoverablePluginTree(pluginsDir: string): boolean {
  try {
    return fs.readdirSync(pluginsDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const pluginDir = path.join(pluginsDir, entry.name);
      return (
        fs.existsSync(path.join(pluginDir, "package.json")) ||
        fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"))
      );
    });
  } catch {
    return false;
  }
}

function isSourceCheckoutExtensionsDir(extensionsDir: string): boolean {
  const packageRoot = path.dirname(extensionsDir);
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(extensionsDir) &&
    hasDiscoverablePluginTree(extensionsDir)
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

function readChildDirectoryNames(dir: string | undefined): Set<string> {
  if (!dir || !fs.existsSync(dir)) {
    return new Set();
  }
  try {
    return new Set(
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

function discoverFromPath(params: {
  rawPath: string;
  origin: PluginOrigin;
  ownershipUid?: number | null;
  workspaceDir?: string;
  requireBuiltRuntimeEntry?: boolean;
  managedPluginDirs?: Set<string>;
  skipRootDirKeys?: Set<string>;
  env: NodeJS.ProcessEnv;
  candidates: PluginCandidate[];
  diagnostics: PluginDiagnostic[];
  seen: Set<string>;
  realpathCache: Map<string, string>;
}) {
  const resolved = resolveUserPath(params.rawPath, params.env);
  if (!fs.existsSync(resolved)) {
    params.diagnostics.push({
      level: "error",
      message: `plugin path not found: ${resolved}`,
      source: resolved,
    });
    return;
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (!isExtensionFile(resolved)) {
      params.diagnostics.push({
        level: "error",
        message: `plugin path is not a supported file: ${resolved}`,
        source: resolved,
      });
      return;
    }
    addCandidate({
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      idHint: path.basename(resolved, path.extname(resolved)),
      source: resolved,
      rootDir: path.dirname(resolved),
      origin: params.origin,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      realpathCache: params.realpathCache,
    });
    return;
  }

  if (stat.isDirectory()) {
    const resolvedRealPath = safeRealpathSync(resolved, params.realpathCache) ?? undefined;
    const requireBuiltRuntimeEntry =
      params.requireBuiltRuntimeEntry ??
      isManagedPluginDir({
        dir: resolved,
        realpath: resolvedRealPath,
        managedPluginDirs: params.managedPluginDirs,
        realpathCache: params.realpathCache,
      });
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: params.origin,
      rootDir: resolved,
      env: params.env,
      realpathCache: params.realpathCache,
    });
    const manifest = readCandidatePackageManifest({
      dir: resolved,
      origin: params.origin,
      rejectHardlinks,
      ...(resolvedRealPath !== undefined ? { rootRealPath: resolvedRealPath } : {}),
    });
    const extensionResolution = resolvePackageExtensionEntries(manifest ?? undefined);
    const extensions = extensionResolution.status === "ok" ? extensionResolution.entries : [];
    const manifestId = resolveIdHintManifestId(resolved, rejectHardlinks, resolvedRealPath);
    const setupSource = resolvePackageSetupSource({
      packageDir: resolved,
      ...(resolvedRealPath !== undefined ? { packageRootRealPath: resolvedRealPath } : {}),
      manifest,
      origin: params.origin,
      requireBuiltRuntimeEntry,
      sourceLabel: resolved,
      diagnostics: params.diagnostics,
      rejectHardlinks,
    });

    if (extensions.length > 0) {
      const resolvedRuntimeSources = resolvePackageRuntimeExtensionSources({
        packageDir: resolved,
        ...(resolvedRealPath !== undefined ? { packageRootRealPath: resolvedRealPath } : {}),
        manifest,
        extensions,
        origin: params.origin,
        pluginIdHint: derivePackagePluginIdHint({ manifestId, packageName: manifest?.name }),
        requireBuiltRuntimeEntry,
        sourceLabel: resolved,
        diagnostics: params.diagnostics,
        rejectHardlinks,
      });
      for (const source of resolvedRuntimeSources) {
        addCandidate({
          candidates: params.candidates,
          diagnostics: params.diagnostics,
          seen: params.seen,
          idHint: deriveIdHint({
            filePath: source,
            manifestId,
            packageName: manifest?.name,
            hasMultipleExtensions: extensions.length > 1,
          }),
          source,
          ...(setupSource ? { setupSource } : {}),
          rootDir: resolved,
          origin: params.origin,
          ownershipUid: params.ownershipUid,
          workspaceDir: params.workspaceDir,
          manifest,
          packageDir: resolved,
          realpathCache: params.realpathCache,
        });
      }
      return;
    }

    const bundleDiscovery = discoverBundleInRoot({
      rootDir: resolved,
      origin: params.origin,
      env: params.env,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      manifest,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      realpathCache: params.realpathCache,
    });
    if (bundleDiscovery === "added") {
      return;
    }

    const indexFile = [...DEFAULT_PLUGIN_ENTRY_CANDIDATES]
      .map((candidate) => path.join(resolved, candidate))
      .find((candidate) => fs.existsSync(candidate));

    if (indexFile && isExtensionFile(indexFile)) {
      addCandidate({
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        seen: params.seen,
        idHint: manifestId ?? path.basename(resolved),
        source: indexFile,
        ...(setupSource ? { setupSource } : {}),
        rootDir: resolved,
        origin: params.origin,
        ownershipUid: params.ownershipUid,
        workspaceDir: params.workspaceDir,
        manifest,
        packageDir: resolved,
        realpathCache: params.realpathCache,
      });
      return;
    }

    discoverInDirectory({
      dir: resolved,
      origin: params.origin,
      env: params.env,
      ownershipUid: params.ownershipUid,
      workspaceDir: params.workspaceDir,
      candidates: params.candidates,
      diagnostics: params.diagnostics,
      seen: params.seen,
      realpathCache: params.realpathCache,
      ...(params.requireBuiltRuntimeEntry !== undefined
        ? { requireBuiltRuntimeEntry: params.requireBuiltRuntimeEntry }
        : {}),
      ...(params.managedPluginDirs ? { managedPluginDirs: params.managedPluginDirs } : {}),
      ...(params.skipRootDirKeys ? { skipRootDirKeys: params.skipRootDirKeys } : {}),
    });
    return;
  }
}

export function discoverOpenClawPlugins(params: {
  workspaceDir?: string;
  extraPaths?: string[];
  installRecords?: Record<string, PluginInstallRecord>;
  ownershipUid?: number | null;
  env?: NodeJS.ProcessEnv;
}): PluginDiscoveryResult {
  const env = params.env ?? process.env;
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const workspaceRoot = workspaceDir ? resolveUserPath(workspaceDir, env) : undefined;
  const roots = resolvePluginSourceRoots({ workspaceDir: workspaceRoot, env });
  const scopedResult = tracePluginLifecyclePhase(
    "discovery scan",
    () => {
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      const realpathCache = new Map<string, string>();
      const extra = params.extraPaths ?? [];
      for (const extraPath of extra) {
        if (typeof extraPath !== "string") {
          continue;
        }
        const trimmed = extraPath.trim();
        if (!trimmed) {
          continue;
        }
        const bundledAlias = resolvePackagedBundledLoadPathAlias({
          bundledRoot: roots.stock,
          loadPath: resolveUserPath(trimmed, env),
        });
        if (bundledAlias) {
          result.diagnostics.push({
            level: "warn",
            source: trimmed,
            message: `ignored plugins.load.paths entry that points at OpenClaw's ${bundledAlias.kind} bundled plugin directory; remove this redundant path or run openclaw doctor --fix`,
          });
          continue;
        }
        discoverFromPath({
          rawPath: trimmed,
          origin: "config",
          ownershipUid: params.ownershipUid,
          workspaceDir,
          env,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
      }
      const workspaceMatchesBundledRoot = resolvesToSameDirectory(
        workspaceRoot,
        roots.stock,
        realpathCache,
      );
      if (roots.workspace && workspaceRoot && !workspaceMatchesBundledRoot) {
        // Keep workspace auto-discovery constrained to the OpenClaw extensions root.
        // Recursively scanning the full workspace treats arbitrary project folders as
        // plugin candidates and causes noisy "plugin manifest not found" validation failures.
        discoverInDirectory({
          dir: roots.workspace,
          origin: "workspace",
          env,
          ownershipUid: params.ownershipUid,
          workspaceDir: workspaceRoot,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
      }
      return result;
    },
    { scope: "scoped", extraPathCount: params.extraPaths?.length ?? 0 },
  );
  const sharedResult = tracePluginLifecyclePhase(
    "discovery scan",
    () => {
      const result = createDiscoveryResult();
      const seen = new Set<string>();
      const realpathCache = new Map<string, string>();
      for (const sourceOverlayDir of listBundledSourceOverlayDirs({
        bundledRoot: roots.stock,
        env,
      })) {
        discoverFromPath({
          rawPath: sourceOverlayDir,
          origin: "bundled",
          ownershipUid: params.ownershipUid,
          workspaceDir,
          env,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
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
      if (roots.stock) {
        discoverInDirectory({
          dir: roots.stock,
          origin: "bundled",
          env,
          ownershipUid: params.ownershipUid,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
      }
      const sourceCheckoutExtensionsDir = resolveBundledSourceCheckoutExtensionsDir(roots.stock);
      const sourceCheckoutMatchesBundledRoot = resolvesToSameDirectory(
        sourceCheckoutExtensionsDir,
        roots.stock,
        realpathCache,
      );
      if (sourceCheckoutExtensionsDir && !sourceCheckoutMatchesBundledRoot) {
        discoverInDirectory({
          dir: sourceCheckoutExtensionsDir,
          origin: "bundled",
          env,
          ownershipUid: params.ownershipUid,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
          skipDirectories: readChildDirectoryNames(roots.stock),
        });
      }
      const installedPaths = collectInstalledPluginRecordPaths(params.installRecords, env);
      const installedPluginDirKeys = collectManagedPluginDirKeys(installedPaths, realpathCache);
      const managedPluginDirs = collectManagedPluginDirKeys(
        collectManagedPluginRecordPaths(params.installRecords, env),
        realpathCache,
      );
      for (const installedPath of installedPaths) {
        discoverFromPath({
          rawPath: installedPath,
          origin: "global",
          ownershipUid: params.ownershipUid,
          workspaceDir,
          requireBuiltRuntimeEntry: true,
          managedPluginDirs,
          env,
          candidates: result.candidates,
          diagnostics: result.diagnostics,
          seen,
          realpathCache,
        });
      }
      // Keep auto-discovered global extensions behind bundled plugins.
      // Users can still intentionally override via plugins.load.paths (origin=config).
      discoverInDirectory({
        dir: roots.global,
        origin: "global",
        env,
        ownershipUid: params.ownershipUid,
        managedPluginDirs,
        skipRootDirKeys: installedPluginDirKeys,
        candidates: result.candidates,
        diagnostics: result.diagnostics,
        seen,
        realpathCache,
      });
      return result;
    },
    { scope: "shared" },
  );
  const result = createDiscoveryResult();
  const seenSources = new Set<string>();
  const seenDiagnostics = new Set<string>();
  mergeDiscoveryResult(result, scopedResult, seenSources, seenDiagnostics);
  mergeDiscoveryResult(result, sharedResult, seenSources, seenDiagnostics);
  return result;
}
