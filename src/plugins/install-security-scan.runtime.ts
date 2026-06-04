// Runtime bridge for plugin install security scanning.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { tryReadJson } from "../infra/json-files.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import {
  runInstallPolicy,
  type InstallPolicyFinding,
  type InstallPolicyOrigin,
  type InstallPolicyRequestKind,
  type InstallPolicySource,
} from "../security/install-policy.js";
import { isPathInside } from "../security/scan-paths.js";
import {
  findBlockedManifestDependencies,
  findBlockedNodeModulesDirectory,
  findBlockedNodeModulesFileAlias,
  findBlockedPackageDirectoryInPath,
  findBlockedPackageFileAliasInPath,
  type BlockedPackageDirectoryFinding,
  type BlockedPackageFileFinding,
} from "./dependency-denylist.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import { createBeforeInstallHookPayload } from "./install-policy-context.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";

type InstallScanLogger = {
  warn?: (message: string) => void;
};

const FULL_GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type PluginInstallRequestKind = Exclude<InstallPolicyRequestKind, "skill-install">;

function formatInstallPolicyWarning(finding: InstallPolicyFinding): string {
  const location = finding.file
    ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
    : "";
  return `Install policy: ${finding.message}${location}`;
}

type InstallScanFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
  evidence?: string;
};

type BuiltinInstallScan = {
  status: "ok" | "error";
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: InstallScanFinding[];
  error?: string;
};

type PackageExecutableScanMetadata = {
  runtimeExtensions?: readonly string[];
  runtimeSetupEntry?: string;
  setupEntry?: string;
};

type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: unknown;
  peerDependencies?: Record<string, string>;
};

type PackageManifestTraversalLimits = {
  maxDepth: number;
  maxDirectories: number;
  maxManifests: number;
};

type PackageManifestTraversalResult = {
  blockedDirectoryFinding?: BlockedPackageDirectoryFinding;
  blockedFileFinding?: BlockedPackageFileFinding;
  packageManifestPaths: string[];
};

type InstalledPackageScanRoot = {
  packageDir: string;
  realPath: string;
};

type SkillInstallSpec = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

export type InstallSecurityScanResult = {
  blocked?: {
    code?: "security_scan_blocked" | "security_scan_failed";
    reason: string;
  };
};

const DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS: PackageManifestTraversalLimits = {
  maxDepth: 64,
  maxDirectories: 10_000,
  maxManifests: 10_000,
};

function buildBlockedDependencyManifestLabel(params: {
  manifestPackageName?: string;
  manifestRelativePath: string;
}) {
  const manifestLabel =
    typeof params.manifestPackageName === "string" && params.manifestPackageName.trim()
      ? `${params.manifestPackageName.trim()} (${params.manifestRelativePath})`
      : params.manifestRelativePath;
  return manifestLabel;
}

function buildBlockedDependencyReason(params: {
  findings: Array<{
    dependencyName: string;
    declaredAs?: string;
    field: "dependencies" | "name" | "optionalDependencies" | "overrides" | "peerDependencies";
  }>;
  manifestPackageName?: string;
  manifestRelativePath: string;
  targetLabel: string;
}) {
  const manifestLabel = buildBlockedDependencyManifestLabel({
    manifestPackageName: params.manifestPackageName,
    manifestRelativePath: params.manifestRelativePath,
  });
  const findingSummary = params.findings
    .map((finding) =>
      finding.field === "name"
        ? `"${finding.dependencyName}" as package name`
        : finding.declaredAs
          ? `"${finding.dependencyName}" via alias "${finding.declaredAs}" in ${finding.field}`
          : `"${finding.dependencyName}" in ${finding.field}`,
    )
    .join(", ");
  return `${params.targetLabel} blocked: blocked dependencies ${findingSummary} declared in ${manifestLabel}.`;
}

function buildBlockedDependencyDirectoryReason(params: {
  dependencyName: string;
  directoryRelativePath: string;
  targetLabel: string;
}) {
  return `${params.targetLabel} blocked: blocked dependency directory "${params.dependencyName}" declared at ${params.directoryRelativePath}.`;
}

function buildBlockedDependencyFileReason(params: {
  dependencyName: string;
  fileRelativePath: string;
  targetLabel: string;
}) {
  return `${params.targetLabel} blocked: blocked dependency file alias "${params.dependencyName}" declared at ${params.fileRelativePath}.`;
}

function pathContainsNodeModulesSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/)
    .map((segment) => segment.trim().toLowerCase())
    .includes("node_modules");
}

function isPackageRootOpenClawPeerSymlink(segments: string[]): boolean {
  return (
    (segments.length === 2 && segments[0] === "node_modules" && segments[1] === "openclaw") ||
    (segments.length === 3 &&
      segments[0] === "node_modules" &&
      segments[1] === ".bin" &&
      segments[2] === "openclaw")
  );
}

function isManagedNpmRootPackagePeerSymlink(segments: string[]): boolean {
  if (segments[0] !== "node_modules") {
    return false;
  }
  const packageEndIndex = segments[1]?.startsWith("@") ? 3 : 2;
  const packageNameSegments = segments.slice(1, packageEndIndex);
  if (
    packageNameSegments.length === 0 ||
    packageNameSegments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return false;
  }
  return isPackageRootOpenClawPeerSymlink(segments.slice(packageEndIndex));
}

function isTrustedOpenClawPeerSymlink(params: {
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  relativePath: string;
}): boolean {
  const segments = params.relativePath.split(/[\\/]+/);
  return (
    isPackageRootOpenClawPeerSymlink(segments) ||
    (params.allowManagedNpmRootPackagePeerSymlinks === true &&
      isManagedNpmRootPackagePeerSymlink(segments))
  );
}

async function resolveTrustedHostOpenClawRootRealPath(): Promise<string | null> {
  const hostRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });
  if (!hostRoot) {
    return null;
  }
  return await fs.realpath(hostRoot).catch(() => path.resolve(hostRoot));
}

function isTrustedHostOpenClawPath(params: {
  resolvedTargetPath: string;
  trustedHostOpenClawRootRealPath: string | null;
}): boolean {
  return (
    params.trustedHostOpenClawRootRealPath !== null &&
    isPathInside(params.trustedHostOpenClawRootRealPath, params.resolvedTargetPath)
  );
}

async function inspectNodeModulesSymlinkTarget(params: {
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  rootRealPath: string;
  symlinkPath: string;
  symlinkRelativePath: string;
  trustedHostOpenClawRootRealPath: string | null;
}): Promise<
  Pick<PackageManifestTraversalResult, "blockedDirectoryFinding" | "blockedFileFinding">
> {
  let resolvedTargetPath: string;
  try {
    resolvedTargetPath = await fs.realpath(params.symlinkPath);
  } catch (error) {
    throw new Error(
      `manifest dependency scan could not resolve symlink target ${params.symlinkRelativePath}: ${String(error)}`,
      {
        cause: error,
      },
    );
  }

  if (!isPathInside(params.rootRealPath, resolvedTargetPath)) {
    if (
      isTrustedOpenClawPeerSymlink({
        allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
        relativePath: params.symlinkRelativePath,
      }) &&
      isTrustedHostOpenClawPath({
        resolvedTargetPath,
        trustedHostOpenClawRootRealPath: params.trustedHostOpenClawRootRealPath,
      })
    ) {
      return {};
    }
    throw new Error(
      `manifest dependency scan found node_modules symlink target outside install root at ${params.symlinkRelativePath}`,
    );
  }

  const resolvedTargetStats = await fs.stat(resolvedTargetPath);
  const resolvedTargetRelativePath = path.relative(params.rootRealPath, resolvedTargetPath);
  const blockedDirectoryFinding = findBlockedPackageDirectoryInPath({
    pathRelativeToRoot: resolvedTargetRelativePath,
  });
  return {
    blockedDirectoryFinding,
    blockedFileFinding: resolvedTargetStats.isFile()
      ? findBlockedPackageFileAliasInPath({
          pathRelativeToRoot: resolvedTargetRelativePath,
        })
      : undefined,
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }
  const parsedValue = parseStrictPositiveInteger(rawValue);
  return parsedValue ?? fallback;
}

function resolvePackageManifestTraversalLimits(): PackageManifestTraversalLimits {
  return {
    maxDepth: readPositiveIntegerEnv(
      "OPENCLAW_INSTALL_SCAN_MAX_DEPTH",
      DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS.maxDepth,
    ),
    maxDirectories: readPositiveIntegerEnv(
      "OPENCLAW_INSTALL_SCAN_MAX_DIRECTORIES",
      DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS.maxDirectories,
    ),
    maxManifests: readPositiveIntegerEnv(
      "OPENCLAW_INSTALL_SCAN_MAX_MANIFESTS",
      DEFAULT_PACKAGE_MANIFEST_TRAVERSAL_LIMITS.maxManifests,
    ),
  };
}

function isSamePathOrInside(parentPath: string, candidatePath: string): boolean {
  return parentPath === candidatePath || isPathInside(parentPath, candidatePath);
}

function getErrnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isInstallScannableDependencyName(name: string): boolean {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    return (
      parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
    );
  }
  return (
    name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".."
  );
}

function collectManifestRuntimeDependencyNames(manifest: PackageManifest): string[] {
  const dependencyNames = new Set<string>();
  for (const dependencies of [manifest.dependencies, manifest.optionalDependencies]) {
    for (const dependencyName of Object.keys(dependencies ?? {})) {
      if (isInstallScannableDependencyName(dependencyName)) {
        dependencyNames.add(dependencyName);
      }
    }
  }
  for (const dependencyName of Object.keys(manifest.peerDependencies ?? {})) {
    if (dependencyName !== "openclaw" && isInstallScannableDependencyName(dependencyName)) {
      dependencyNames.add(dependencyName);
    }
  }
  return [...dependencyNames].toSorted((left, right) => left.localeCompare(right));
}

async function resolveInstalledPackageScanRoot(params: {
  boundaryRealPath: string;
  dependencyName: string;
  packageDir: string;
}): Promise<InstalledPackageScanRoot | undefined> {
  const packageDir = path.join(params.packageDir, "node_modules", params.dependencyName);
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(packageDir);
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    return undefined;
  }

  const realPath = await fs.realpath(packageDir).catch(() => path.resolve(packageDir));
  if (!isSamePathOrInside(params.boundaryRealPath, realPath)) {
    throw new Error(
      `installed dependency scan found package outside install root at ${packageDir}`,
    );
  }
  return { packageDir, realPath };
}

async function collectInstalledPackageScanRoots(params: {
  additionalPackageDirs?: string[];
  dependencyScanRootDir?: string;
  packageDir: string;
}): Promise<string[]> {
  const limits = resolvePackageManifestTraversalLimits();
  const boundaryDir = params.dependencyScanRootDir ?? params.packageDir;
  const boundaryRealPath = await fs.realpath(boundaryDir).catch(() => path.resolve(boundaryDir));
  const packageRealPath = await fs
    .realpath(params.packageDir)
    .catch(() => path.resolve(params.packageDir));
  if (!isSamePathOrInside(boundaryRealPath, packageRealPath)) {
    throw new Error(
      `installed dependency scan found package outside install root at ${params.packageDir}`,
    );
  }

  const queue: InstalledPackageScanRoot[] = [
    { packageDir: params.packageDir, realPath: packageRealPath },
  ];
  for (const packageDir of params.additionalPackageDirs ?? []) {
    const realPath = await fs.realpath(packageDir).catch(() => path.resolve(packageDir));
    if (!isSamePathOrInside(boundaryRealPath, realPath)) {
      throw new Error(
        `installed dependency scan found package outside install root at ${packageDir}`,
      );
    }
    queue.push({ packageDir, realPath });
  }
  const visitedRealPaths = new Set<string>();
  const scanRoots: string[] = [];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current || visitedRealPaths.has(current.realPath)) {
      continue;
    }
    visitedRealPaths.add(current.realPath);
    if (visitedRealPaths.size > limits.maxDirectories) {
      throw new Error(
        `installed dependency scan exceeded max packages (${limits.maxDirectories}) under ${boundaryDir}`,
      );
    }
    scanRoots.push(current.packageDir);

    const manifest = await tryReadJson<PackageManifest>(
      path.join(current.packageDir, "package.json"),
    );
    if (!manifest) {
      continue;
    }
    for (const dependencyName of collectManifestRuntimeDependencyNames(manifest)) {
      const nestedCandidate = await resolveInstalledPackageScanRoot({
        boundaryRealPath,
        dependencyName,
        packageDir: current.packageDir,
      });
      const candidate =
        nestedCandidate ??
        (params.dependencyScanRootDir
          ? await resolveInstalledPackageScanRoot({
              boundaryRealPath,
              dependencyName,
              packageDir: params.dependencyScanRootDir,
            })
          : undefined);
      if (candidate && !visitedRealPaths.has(candidate.realPath)) {
        queue.push(candidate);
      }
    }
  }

  return scanRoots;
}

async function collectNonOverlappingPackageScanRoots(packageDirs: string[]): Promise<string[]> {
  const selectedRoots: InstalledPackageScanRoot[] = [];
  for (const packageDir of packageDirs) {
    const realPath = await fs.realpath(packageDir).catch(() => path.resolve(packageDir));
    if (selectedRoots.some((selectedRoot) => isSamePathOrInside(selectedRoot.realPath, realPath))) {
      continue;
    }
    selectedRoots.push({ packageDir, realPath });
  }
  return selectedRoots.map((selectedRoot) => selectedRoot.packageDir);
}

async function collectPackageManifestPaths(params: {
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  rootDir: string;
}): Promise<PackageManifestTraversalResult> {
  const limits = resolvePackageManifestTraversalLimits();
  const rootDir = params.rootDir;
  const rootRealPath = await fs.realpath(rootDir).catch(() => rootDir);
  const trustedHostOpenClawRootRealPath = await resolveTrustedHostOpenClawRootRealPath();
  const queue: Array<{ depth: number; dir: string }> = [{ depth: 0, dir: rootDir }];
  const packageManifestPaths: string[] = [];
  const visitedDirectories = new Set<string>();
  let firstBlockedDirectoryFinding: BlockedPackageDirectoryFinding | undefined;
  let firstBlockedFileFinding: BlockedPackageFileFinding | undefined;
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current) {
      continue;
    }

    if (current.depth > limits.maxDepth) {
      throw new Error(
        `manifest dependency scan exceeded max depth (${limits.maxDepth}) at ${current.dir}`,
      );
    }

    const currentDir = current.dir;
    const currentRealPath = await fs.realpath(currentDir).catch(() => currentDir);
    if (visitedDirectories.has(currentRealPath)) {
      continue;
    }
    visitedDirectories.add(currentRealPath);
    if (visitedDirectories.size > limits.maxDirectories) {
      throw new Error(
        `manifest dependency scan exceeded max directories (${limits.maxDirectories}) under ${rootDir}`,
      );
    }

    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = await fs.readdir(currentDir, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      throw new Error(`manifest dependency scan could not read ${currentDir}: ${String(error)}`, {
        cause: error,
      });
    }

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const nextPath = path.join(currentDir, entry.name);
      const relativeNextPath = path.relative(rootDir, nextPath) || entry.name;
      if (entry.isSymbolicLink()) {
        const blockedDirectoryFinding = findBlockedNodeModulesDirectory({
          directoryRelativePath: relativeNextPath,
        });
        if (blockedDirectoryFinding) {
          firstBlockedDirectoryFinding ??= blockedDirectoryFinding;
        }
        const blockedFileFinding = findBlockedNodeModulesFileAlias({
          fileRelativePath: relativeNextPath,
        });
        if (blockedFileFinding) {
          firstBlockedFileFinding ??= blockedFileFinding;
        }
        if (pathContainsNodeModulesSegment(relativeNextPath)) {
          const symlinkTargetInspection = await inspectNodeModulesSymlinkTarget({
            allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
            rootRealPath,
            symlinkPath: nextPath,
            symlinkRelativePath: relativeNextPath,
            trustedHostOpenClawRootRealPath,
          });
          if (symlinkTargetInspection.blockedDirectoryFinding) {
            firstBlockedDirectoryFinding ??= symlinkTargetInspection.blockedDirectoryFinding;
          }
          if (symlinkTargetInspection.blockedFileFinding) {
            firstBlockedFileFinding ??= symlinkTargetInspection.blockedFileFinding;
          }
        }
        continue;
      }
      if (entry.isDirectory()) {
        const blockedDirectoryFinding = findBlockedNodeModulesDirectory({
          directoryRelativePath: relativeNextPath,
        });
        if (blockedDirectoryFinding) {
          firstBlockedDirectoryFinding ??= blockedDirectoryFinding;
        }
        queue.push({ depth: current.depth + 1, dir: nextPath });
        continue;
      }
      if (entry.isFile()) {
        const blockedFileFinding = findBlockedNodeModulesFileAlias({
          fileRelativePath: relativeNextPath,
        });
        if (blockedFileFinding) {
          firstBlockedFileFinding ??= blockedFileFinding;
        }
      }
      if (entry.isFile() && entry.name === "package.json") {
        packageManifestPaths.push(nextPath);
        if (packageManifestPaths.length > limits.maxManifests) {
          throw new Error(
            `manifest dependency scan exceeded max manifests (${limits.maxManifests}) under ${rootDir}`,
          );
        }
      }
    }
  }

  return {
    packageManifestPaths,
    blockedDirectoryFinding: firstBlockedDirectoryFinding,
    blockedFileFinding: firstBlockedFileFinding,
  };
}

function formatPackageScanRelativePath(params: {
  packageDir: string;
  relativePath: string;
  relativeRootDir?: string;
}): string {
  if (!params.relativeRootDir) {
    return params.relativePath;
  }
  const packageRelativePath = path.relative(params.relativeRootDir, params.packageDir);
  return packageRelativePath
    ? path.join(packageRelativePath, params.relativePath)
    : params.relativePath;
}

async function scanPluginDependencyDenylist(params: {
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  logger: InstallScanLogger;
  packageDir: string;
  relativeRootDir?: string;
  targetLabel: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const traversalResult = await collectPackageManifestPaths({
    allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
    rootDir: params.packageDir,
  });
  for (const manifestPath of traversalResult.packageManifestPaths) {
    const manifest = await tryReadJson<PackageManifest>(manifestPath);
    if (!manifest) {
      continue;
    }

    const blockedDependencies = findBlockedManifestDependencies(manifest);
    if (blockedDependencies.length === 0) {
      continue;
    }

    const manifestRelativePath = formatPackageScanRelativePath({
      packageDir: params.packageDir,
      relativePath: path.relative(params.packageDir, manifestPath) || "package.json",
      relativeRootDir: params.relativeRootDir,
    });
    const reason = buildBlockedDependencyReason({
      findings: blockedDependencies,
      manifestPackageName: manifest.name,
      manifestRelativePath,
      targetLabel: params.targetLabel,
    });
    params.logger.warn?.(`WARNING: ${reason}`);
    return {
      blocked: {
        code: "security_scan_blocked",
        reason,
      },
    };
  }

  if (traversalResult.blockedDirectoryFinding) {
    const reason = buildBlockedDependencyDirectoryReason({
      dependencyName: traversalResult.blockedDirectoryFinding.dependencyName,
      directoryRelativePath: formatPackageScanRelativePath({
        packageDir: params.packageDir,
        relativePath: traversalResult.blockedDirectoryFinding.directoryRelativePath,
        relativeRootDir: params.relativeRootDir,
      }),
      targetLabel: params.targetLabel,
    });
    params.logger.warn?.(`WARNING: ${reason}`);
    return {
      blocked: {
        code: "security_scan_blocked",
        reason,
      },
    };
  }
  if (traversalResult.blockedFileFinding) {
    const reason = buildBlockedDependencyFileReason({
      dependencyName: traversalResult.blockedFileFinding.dependencyName,
      fileRelativePath: formatPackageScanRelativePath({
        packageDir: params.packageDir,
        relativePath: traversalResult.blockedFileFinding.fileRelativePath,
        relativeRootDir: params.relativeRootDir,
      }),
      targetLabel: params.targetLabel,
    });
    params.logger.warn?.(`WARNING: ${reason}`);
    return {
      blocked: {
        code: "security_scan_blocked",
        reason,
      },
    };
  }

  return undefined;
}

async function runBeforeInstallHook(params: {
  logger: InstallScanLogger;
  installLabel: string;
  origin: string;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
  source?: InstallPolicySource;
  targetName: string;
  targetType: "skill" | "plugin";
  requestKind: InstallPolicyRequestKind;
  requestMode: "install" | "update";
  requestedSpecifier?: string;
  builtinScan?: BuiltinInstallScan;
  skill?: {
    installId: string;
    installSpec?: SkillInstallSpec;
  };
  plugin?: {
    contentType: "bundle" | "package" | "file";
    pluginId: string;
    packageName?: string;
    manifestId?: string;
    version?: string;
    extensions?: string[];
  };
}): Promise<InstallSecurityScanResult | undefined> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_install")) {
    return undefined;
  }

  try {
    const { event, ctx } = createBeforeInstallHookPayload({
      targetName: params.targetName,
      targetType: params.targetType,
      origin: params.origin,
      sourcePath: params.sourcePath,
      sourcePathKind: params.sourcePathKind,
      request: {
        kind: params.requestKind,
        mode: params.requestMode,
        ...(params.requestedSpecifier ? { requestedSpecifier: params.requestedSpecifier } : {}),
      },
      builtinScan: params.builtinScan,
      ...(params.skill ? { skill: params.skill } : {}),
      ...(params.plugin ? { plugin: params.plugin } : {}),
    });
    const hookResult = await hookRunner.runBeforeInstall(event, ctx);
    if (hookResult?.block) {
      const reason = hookResult.blockReason || "Installation blocked by plugin hook";
      params.logger.warn?.(`WARNING: ${params.installLabel} blocked by plugin hook: ${reason}`);
      return { blocked: { code: "security_scan_blocked", reason } };
    }
    if (hookResult?.findings) {
      for (const finding of hookResult.findings) {
        if (finding.severity === "critical" || finding.severity === "warn") {
          params.logger.warn?.(
            `Plugin scanner: ${finding.message} (${finding.file}:${finding.line})`,
          );
        }
      }
    }
  } catch (err) {
    const reason = `Installation blocked because before_install hook failed: ${formatErrorMessage(err)}`;
    params.logger.warn?.(
      `WARNING: ${params.installLabel} blocked by plugin hook failure: ${reason}`,
    );
    return { blocked: { code: "security_scan_failed", reason } };
  }

  return undefined;
}

function formatInstallPolicyOriginForHook(origin: InstallPolicyOrigin): string {
  const type = typeof origin.type === "string" ? origin.type : "unknown";
  if (type === "upload") {
    return "skill-upload";
  }
  const spec = typeof origin.spec === "string" ? origin.spec : undefined;
  const slug = typeof origin.slug === "string" ? origin.slug : undefined;
  return spec ?? slug ?? type;
}

function isMutableGitOrigin(origin: InstallPolicyOrigin | undefined): boolean {
  const ref = typeof origin?.ref === "string" ? origin.ref : undefined;
  return !FULL_GIT_COMMIT_PATTERN.test(ref ?? "");
}

function resolvePolicySource(params: {
  requestKind: InstallPolicyRequestKind;
  origin?: InstallPolicyOrigin;
}): InstallPolicySource {
  if (params.requestKind === "skill-install") {
    switch (params.origin?.type) {
      case "clawhub":
        return { kind: "clawhub", authority: "openclaw", mutable: false, network: true };
      case "git":
        return {
          kind: "git",
          authority: "third-party",
          mutable: isMutableGitOrigin(params.origin),
          network: true,
        };
      case "path":
        return { kind: "local-path", authority: "user", mutable: true, network: false };
      case "upload":
        return { kind: "upload", authority: "user", mutable: false, network: false };
      case "openclaw-bundled":
        return { kind: "bundled", authority: "openclaw", mutable: false, network: false };
      case "openclaw-managed":
      case "openclaw-extra":
        return { kind: "managed", authority: "openclaw", mutable: false, network: false };
      default:
        return { kind: "workspace", authority: "user", mutable: true, network: false };
    }
  }

  switch (params.requestKind) {
    case "plugin-archive":
      return { kind: "archive", authority: "third-party", mutable: true, network: false };
    case "plugin-file":
      return { kind: "file", authority: "user", mutable: true, network: false };
    case "plugin-git":
      return { kind: "git", authority: "third-party", mutable: true, network: true };
    case "plugin-npm":
      return { kind: "npm", authority: "third-party", mutable: false, network: true };
    case "plugin-dir":
      return { kind: "local-path", authority: "user", mutable: true, network: false };
  }
  return { kind: "local-path", authority: "unknown", mutable: true, network: false };
}

async function runOperatorInstallPolicy(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  origin: InstallPolicyOrigin;
  source?: InstallPolicySource;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
  targetName: string;
  targetType: "skill" | "plugin";
  requestKind: InstallPolicyRequestKind;
  requestMode: "install" | "update";
  requestedSpecifier?: string;
  skill?: {
    installId: string;
    installSpec?: SkillInstallSpec;
  };
  plugin?: {
    contentType: "bundle" | "package" | "file" | "dependency-tree";
    pluginId: string;
    packageName?: string;
    manifestId?: string;
    version?: string;
    extensions?: string[];
  };
}): Promise<InstallSecurityScanResult | undefined> {
  const result = await runInstallPolicy({
    config: params.config,
    logger: params.logger,
    request: {
      targetName: params.targetName,
      targetType: params.targetType,
      sourcePath: params.sourcePath,
      sourcePathKind: params.sourcePathKind,
      ...(params.source ? { source: params.source } : {}),
      origin: params.origin,
      request: {
        kind: params.requestKind,
        mode: params.requestMode,
        ...(params.requestedSpecifier ? { requestedSpecifier: params.requestedSpecifier } : {}),
      },
      ...(params.skill ? { skill: params.skill } : {}),
      ...(params.plugin ? { plugin: params.plugin } : {}),
    },
  });
  if (!result?.blocked) {
    for (const finding of result?.findings ?? []) {
      if (finding.severity === "critical" || finding.severity === "warn") {
        params.logger.warn?.(formatInstallPolicyWarning(finding));
      }
    }
    return undefined;
  }
  return { blocked: result.blocked };
}

export async function scanBundleInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    logger: InstallScanLogger;
    pluginId: string;
    sourceDir: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    version?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const dependencyBlocked = await scanPluginDependencyDenylist({
    logger: params.logger,
    packageDir: params.sourceDir,
    targetLabel: `Bundle "${params.pluginId}" installation`,
  });
  if (dependencyBlocked) {
    return dependencyBlocked;
  }

  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-bundle", ...(params.version ? { version: params.version } : {}) },
    source:
      params.source ?? resolvePolicySource({ requestKind: params.requestKind ?? "plugin-dir" }),
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "bundle",
      pluginId: params.pluginId,
      manifestId: params.pluginId,
      ...(params.version ? { version: params.version } : {}),
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Bundle "${params.pluginId}" installation`,
    origin: "plugin-bundle",
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "bundle",
      pluginId: params.pluginId,
      manifestId: params.pluginId,
      ...(params.version ? { version: params.version } : {}),
    },
  });
  return hookResult;
}

export async function scanPackageInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    extensions: string[];
    logger: InstallScanLogger;
    packageDir: string;
    packageMetadata?: PackageExecutableScanMetadata;
    pluginId: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    packageName?: string;
    manifestId?: string;
    version?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const dependencyBlocked = await scanPluginDependencyDenylist({
    logger: params.logger,
    packageDir: params.packageDir,
    targetLabel: `Plugin "${params.pluginId}" installation`,
  });
  if (dependencyBlocked) {
    return dependencyBlocked;
  }

  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: {
      type: "plugin-package",
      ...(params.packageName ? { packageName: params.packageName } : {}),
      ...(params.version ? { version: params.version } : {}),
    },
    source:
      params.source ?? resolvePolicySource({ requestKind: params.requestKind ?? "plugin-dir" }),
    sourcePath: params.packageDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "package",
      pluginId: params.pluginId,
      ...(params.packageName ? { packageName: params.packageName } : {}),
      ...(params.manifestId ? { manifestId: params.manifestId } : {}),
      ...(params.version ? { version: params.version } : {}),
      extensions: params.extensions.slice(),
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Plugin "${params.pluginId}" installation`,
    origin: "plugin-package",
    sourcePath: params.packageDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "package",
      pluginId: params.pluginId,
      ...(params.packageName ? { packageName: params.packageName } : {}),
      ...(params.manifestId ? { manifestId: params.manifestId } : {}),
      ...(params.version ? { version: params.version } : {}),
      extensions: params.extensions.slice(),
    },
  });
  return hookResult;
}

export async function scanInstalledPackageDependencyTreeRuntime(params: {
  additionalPackageDirs?: string[];
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  config?: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  dependencyScanRootDir?: string;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  packageDir: string;
  pluginId: string;
  requestKind?: PluginInstallRequestKind;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  trustedSourceLinkedOfficialInstall?: boolean;
}): Promise<InstallSecurityScanResult | undefined> {
  const scanRoots = await collectInstalledPackageScanRoots({
    ...(params.additionalPackageDirs
      ? { additionalPackageDirs: params.additionalPackageDirs }
      : {}),
    dependencyScanRootDir: params.dependencyScanRootDir,
    packageDir: params.packageDir,
  });
  const manifestScanRoots = await collectNonOverlappingPackageScanRoots(scanRoots);
  for (const packageDir of manifestScanRoots) {
    const dependencyBlocked = await scanPluginDependencyDenylist({
      logger: params.logger,
      packageDir,
      allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
      relativeRootDir: params.dependencyScanRootDir ?? params.packageDir,
      targetLabel: `Plugin "${params.pluginId}" installation`,
    });
    if (dependencyBlocked) {
      return dependencyBlocked;
    }
  }

  const requestKind = params.requestKind ?? "plugin-npm";
  return await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-dependency-tree" },
    source: params.source ?? resolvePolicySource({ requestKind }),
    sourcePath: params.dependencyScanRootDir ?? params.packageDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind,
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "dependency-tree",
      pluginId: params.pluginId,
    },
  });
}

export async function scanFileInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    filePath: string;
    logger: InstallScanLogger;
    mode?: "install" | "update";
    pluginId: string;
    requestedSpecifier?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-file" },
    source: params.source ?? resolvePolicySource({ requestKind: "plugin-file" }),
    sourcePath: params.filePath,
    sourcePathKind: "file",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: "plugin-file",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "file",
      pluginId: params.pluginId,
      extensions: [path.basename(params.filePath)],
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Plugin file "${params.pluginId}" installation`,
    origin: "plugin-file",
    sourcePath: params.filePath,
    sourcePathKind: "file",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: "plugin-file",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "file",
      pluginId: params.pluginId,
      extensions: [path.basename(params.filePath)],
    },
  });
  return hookResult;
}

export async function preflightPluginNpmInstallPolicyRuntime(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  packageName: string;
  pluginId?: string;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
}): Promise<InstallSecurityScanResult | undefined> {
  const pluginId = params.pluginId ?? params.packageName;
  return await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-npm", packageName: params.packageName },
    source: params.source ?? resolvePolicySource({ requestKind: "plugin-npm" }),
    sourcePath: params.sourcePath,
    sourcePathKind: params.sourcePathKind,
    targetName: pluginId,
    targetType: "plugin",
    requestKind: "plugin-npm",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "package",
      pluginId,
      packageName: params.packageName,
    },
  });
}

export async function preflightPluginGitInstallPolicyRuntime(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  pluginId: string;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  sourcePath: string;
}): Promise<InstallSecurityScanResult | undefined> {
  return await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-git" },
    source: params.source ?? resolvePolicySource({ requestKind: "plugin-git" }),
    sourcePath: params.sourcePath,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: "plugin-git",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "package",
      pluginId: params.pluginId,
    },
  });
}

export async function evaluateSkillInstallPolicyRuntime(params: {
  config?: OpenClawConfig;
  installId: string;
  installSpec?: SkillInstallSpec;
  logger: InstallScanLogger;
  origin: InstallPolicyOrigin;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  mode?: "install" | "update";
  skillName: string;
  sourceDir: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: params.origin,
    source:
      params.source ?? resolvePolicySource({ requestKind: "skill-install", origin: params.origin }),
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.skillName,
    targetType: "skill",
    requestKind: "skill-install",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    skill: {
      installId: params.installId,
      ...(params.installSpec ? { installSpec: params.installSpec } : {}),
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Skill "${params.skillName}" installation`,
    origin: formatInstallPolicyOriginForHook(params.origin),
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.skillName,
    targetType: "skill",
    requestKind: "skill-install",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    skill: {
      installId: params.installId,
      ...(params.installSpec ? { installSpec: params.installSpec } : {}),
    },
  });
  return hookResult;
}
