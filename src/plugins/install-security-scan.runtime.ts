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

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type PackageTraversalLimits = {
  maxDepth: number;
  maxDirectories: number;
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

const DEFAULT_PACKAGE_TRAVERSAL_LIMITS: PackageTraversalLimits = {
  maxDepth: 64,
  maxDirectories: 10_000,
};

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
}): Promise<void> {
  let resolvedTargetPath: string;
  try {
    resolvedTargetPath = await fs.realpath(params.symlinkPath);
  } catch (error) {
    throw new Error(
      `dependency boundary scan could not resolve symlink target ${params.symlinkRelativePath}: ${String(error)}`,
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
      return;
    }
    throw new Error(
      `dependency boundary scan found node_modules symlink target outside install root at ${params.symlinkRelativePath}`,
    );
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }
  const parsedValue = parseStrictPositiveInteger(rawValue);
  return parsedValue ?? fallback;
}

function resolvePackageTraversalLimits(): PackageTraversalLimits {
  return {
    maxDepth: readPositiveIntegerEnv(
      "OPENCLAW_INSTALL_SCAN_MAX_DEPTH",
      DEFAULT_PACKAGE_TRAVERSAL_LIMITS.maxDepth,
    ),
    maxDirectories: readPositiveIntegerEnv(
      "OPENCLAW_INSTALL_SCAN_MAX_DIRECTORIES",
      DEFAULT_PACKAGE_TRAVERSAL_LIMITS.maxDirectories,
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
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  boundaryRealPath: string;
  dependencyName: string;
  packageDir: string;
  trustedHostOpenClawRootRealPath: string | null;
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
    if (
      params.allowManagedNpmRootPackagePeerSymlinks === true &&
      params.dependencyName === "openclaw" &&
      isTrustedHostOpenClawPath({
        resolvedTargetPath: realPath,
        trustedHostOpenClawRootRealPath: params.trustedHostOpenClawRootRealPath,
      })
    ) {
      return undefined;
    }
    throw new Error(
      `installed dependency scan found package outside install root at ${packageDir}`,
    );
  }
  return { packageDir, realPath };
}

async function collectInstalledPackageScanRoots(params: {
  additionalPackageDirs?: string[];
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  dependencyScanRootDir?: string;
  packageDir: string;
}): Promise<string[]> {
  const limits = resolvePackageTraversalLimits();
  const boundaryDir = params.dependencyScanRootDir ?? params.packageDir;
  const boundaryRealPath = await fs.realpath(boundaryDir).catch(() => path.resolve(boundaryDir));
  const trustedHostOpenClawRootRealPath = await resolveTrustedHostOpenClawRootRealPath();
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
        allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
        boundaryRealPath,
        dependencyName,
        packageDir: current.packageDir,
        trustedHostOpenClawRootRealPath,
      });
      const candidate =
        nestedCandidate ??
        (params.dependencyScanRootDir
          ? await resolveInstalledPackageScanRoot({
              allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
              boundaryRealPath,
              dependencyName,
              packageDir: params.dependencyScanRootDir,
              trustedHostOpenClawRootRealPath,
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

async function validatePackageDependencyBoundaries(params: {
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  rootDir: string;
}): Promise<void> {
  const limits = resolvePackageTraversalLimits();
  const rootDir = params.rootDir;
  const rootRealPath = await fs.realpath(rootDir).catch(() => rootDir);
  const trustedHostOpenClawRootRealPath = await resolveTrustedHostOpenClawRootRealPath();
  const queue: Array<{ depth: number; dir: string }> = [{ depth: 0, dir: rootDir }];
  const visitedDirectories = new Set<string>();
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current) {
      continue;
    }

    if (current.depth > limits.maxDepth) {
      throw new Error(
        `dependency boundary scan exceeded max depth (${limits.maxDepth}) at ${current.dir}`,
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
        `dependency boundary scan exceeded max directories (${limits.maxDirectories}) under ${rootDir}`,
      );
    }

    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = await fs.readdir(currentDir, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      throw new Error(`dependency boundary scan could not read ${currentDir}: ${String(error)}`, {
        cause: error,
      });
    }

    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const nextPath = path.join(currentDir, entry.name);
      const relativeNextPath = path.relative(rootDir, nextPath) || entry.name;
      if (entry.isSymbolicLink()) {
        if (pathContainsNodeModulesSegment(relativeNextPath)) {
          await inspectNodeModulesSymlinkTarget({
            allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
            rootRealPath,
            symlinkPath: nextPath,
            symlinkRelativePath: relativeNextPath,
            trustedHostOpenClawRootRealPath,
          });
        }
        continue;
      }
      if (entry.isDirectory()) {
        queue.push({ depth: current.depth + 1, dir: nextPath });
      }
    }
  }
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

function shouldBypassOpenClawInstallFriction(params: {
  source?: InstallPolicySource;
  trustedSourceLinkedOfficialInstall?: boolean;
}): boolean {
  if (params.trustedSourceLinkedOfficialInstall === true) {
    return true;
  }
  const source = params.source;
  if (!source || source.mutable) {
    return false;
  }
  if (source.authority === "official") {
    return source.kind === "clawhub" || source.kind === "git" || source.kind === "npm";
  }
  return (
    source.authority === "openclaw" && (source.kind === "bundled" || source.kind === "managed")
  );
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
  trustedSourceLinkedOfficialInstall?: boolean;
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
  const runPolicy = () =>
    runOperatorInstallPolicy({
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
  await validatePackageDependencyBoundaries({
    rootDir: params.sourceDir,
  });
  if (shouldBypassOpenClawInstallFriction({ source: params.source })) {
    return await runPolicy();
  }

  const policyResult = await runPolicy();
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
    pluginId: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    packageName?: string;
    manifestId?: string;
    version?: string;
    source?: InstallPolicySource;
    trustedSourceLinkedOfficialInstall?: boolean;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const runPolicy = () =>
    runOperatorInstallPolicy({
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
  await validatePackageDependencyBoundaries({
    rootDir: params.packageDir,
  });
  if (
    shouldBypassOpenClawInstallFriction({
      source: params.source,
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    })
  ) {
    return await runPolicy();
  }

  const policyResult = await runPolicy();
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
  const requestKind = params.requestKind ?? "plugin-npm";
  const runPolicy = () =>
    runOperatorInstallPolicy({
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
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    });
  const scanRoots = await collectInstalledPackageScanRoots({
    ...(params.additionalPackageDirs
      ? { additionalPackageDirs: params.additionalPackageDirs }
      : {}),
    dependencyScanRootDir: params.dependencyScanRootDir,
    allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
    packageDir: params.packageDir,
  });
  const boundaryScanRoots = await collectNonOverlappingPackageScanRoots(scanRoots);
  for (const rootDir of boundaryScanRoots) {
    await validatePackageDependencyBoundaries({
      rootDir,
      allowManagedNpmRootPackagePeerSymlinks: params.allowManagedNpmRootPackagePeerSymlinks,
    });
  }
  return await runPolicy();
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
  const runPolicy = () =>
    runOperatorInstallPolicy({
      config: params.config,
      logger: params.logger,
      origin: params.origin,
      source:
        params.source ??
        resolvePolicySource({ requestKind: "skill-install", origin: params.origin }),
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
  if (shouldBypassOpenClawInstallFriction({ source: params.source })) {
    return await runPolicy();
  }
  const policyResult = await runPolicy();
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
