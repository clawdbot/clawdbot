// Installs plugins from package specs, local paths, and catalogs.
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { satisfiesPluginApiRange } from "../infra/clawhub.js";
import { sha256HexPrefix } from "../infra/crypto-digest.js";
import { packageNameMatchesId } from "../infra/install-safe-path.js";
import {
  resolveNpmPackArchiveMetadata,
  resolveNpmSpecMetadata,
  createNpmMetadataEnv,
  type NpmIntegrityDrift,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import {
  type ManagedNpmRootPeerDependencySnapshot,
  listMissingRequiredPlatformPackages,
  readManagedNpmRootInstalledDependency,
  readManagedNpmRootPeerDependencySnapshot,
  readOpenClawManagedNpmRootOverrides,
  repairManagedNpmRootOpenClawPeer,
  removeManagedNpmRootDependency,
  resolveManagedNpmRootDependencySpec,
  restoreManagedNpmRootPeerDependencySnapshot,
  syncManagedNpmRootPeerDependencies,
  upsertManagedNpmRootDependency,
  type ManagedNpmRootInstalledDependency,
} from "../infra/npm-managed-root.js";
import {
  compareOpenClawReleaseVersions,
  formatPrereleaseResolutionError,
  isExactSemverVersion,
  isPrereleaseSemverVersion,
  isPrereleaseResolutionAllowed,
  parseRegistryNpmSpec,
  validateRegistryNpmSpec,
  type ParsedRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import { installedPackageNeedsOpenClawPeerLinkRepair } from "../infra/package-update-utils.js";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";
import { compareValidSemver } from "../infra/semver.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { InstallPolicySource } from "../security/install-policy.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveUserPath } from "../utils.js";
import {
  encodePluginInstallDirName,
  matchesExpectedPluginId,
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmGenerationProjectDirPrefix,
  resolvePluginNpmProjectDir,
  safePluginInstallFileName,
  validatePluginId,
} from "./install-paths.js";
import {
  preflightPluginNpmInstallPolicy,
  type InstallSecurityScanResult,
  type InstallSafetyOverrides,
} from "./install-security-scan.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import {
  resolvePackageExtensionEntries,
  type OpenClawPackageManifest,
  type PackageManifest as PluginPackageManifest,
} from "./manifest.js";
import { resolvePackagePluginApiRange } from "./package-compat.js";
import { validatePackageExtensionEntriesForInstall } from "./package-entry-resolution.js";
import {
  linkOpenClawPeerDependencies,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";
import {
  emitPluginAuditSecurityEvent,
  emitPluginInstallSecurityEvent,
  pluginAuditOutcomeForReason,
  type PluginSecuritySourceFamily,
} from "./security-events.js";

export { resolvePluginInstallDir } from "./install-paths.js";

const pluginInstallRuntimeLoader = createLazyImportLoader(() => import("./install.runtime.js"));
const rollbackSnapshotCopyMode = fsConstants.COPYFILE_FICLONE;

async function loadPluginInstallRuntime() {
  return await pluginInstallRuntimeLoader.load();
}

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = PluginPackageManifest & {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
type PluginInstallRuntime = Awaited<ReturnType<typeof loadPluginInstallRuntime>>;

function formatUnresolvedOpenClawPeerLinkError(packageName: string): string {
  return `Installed plugin ${packageName} declares openclaw as a peer dependency, but OpenClaw could not create a plugin-local node_modules/openclaw link. Run from a packaged OpenClaw install or reinstall OpenClaw, then retry.`;
}

function isNpmAliasOverrideComparatorError(result: { stdout: string; stderr: string }): boolean {
  return `${result.stderr}\n${result.stdout}`.includes("Invalid comparator: npm:");
}

const MISSING_EXTENSIONS_ERROR =
  'package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example ["./dist/index.js"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions';
const PLUGIN_ARCHIVE_ROOT_MARKERS = [
  "package.json",
  "openclaw.plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];
const MANAGED_NPM_PACK_ARCHIVE_DIR = "_openclaw-pack-archives";
const MANAGED_NPM_PROJECT_QUARANTINE_DIR = "_openclaw-quarantined-npm-projects";
const MANAGED_NPM_PROJECT_REBUILD_ARTIFACTS = [
  "node_modules",
  "package-lock.json",
  "npm-shrinkwrap.json",
] as const;

export const PLUGIN_INSTALL_ERROR_CODE = {
  INVALID_NPM_SPEC: "invalid_npm_spec",
  INVALID_MIN_HOST_VERSION: "invalid_min_host_version",
  UNKNOWN_HOST_VERSION: "unknown_host_version",
  INCOMPATIBLE_HOST_VERSION: "incompatible_host_version",
  INCOMPATIBLE_PLUGIN_API: "incompatible_plugin_api",
  INVALID_PLUGIN_API: "invalid_plugin_api",
  MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions",
  MISSING_PLUGIN_MANIFEST: "missing_plugin_manifest",
  EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions",
  INVALID_OPENCLAW_EXTENSIONS: "invalid_openclaw_extensions",
  NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  SECURITY_SCAN_BLOCKED: "security_scan_blocked",
  SECURITY_SCAN_FAILED: "security_scan_failed",
  UNSUPPORTED_PLAIN_FILE_PLUGIN: "unsupported_plain_file_plugin",
} as const;

type PluginInstallErrorCode =
  (typeof PLUGIN_INSTALL_ERROR_CODE)[keyof typeof PLUGIN_INSTALL_ERROR_CODE];

export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      manifestName?: string;
      version?: string;
      extensions: string[];
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | { ok: false; error: string; code?: PluginInstallErrorCode };

type PluginInstallFailureResult = Extract<InstallPluginResult, { ok: false }>;

function validateOpenClawPackageCompatibility(params: {
  pluginId: string;
  currentHostVersion: string;
  packageMetadata?: OpenClawPackageManifest;
}): PluginInstallFailureResult | null {
  const pluginApiRangeCheck = resolvePackagePluginApiRange(params.packageMetadata);
  if (!pluginApiRangeCheck.ok) {
    return {
      ok: false,
      error: `invalid package.json openclaw.compat.pluginApi: ${pluginApiRangeCheck.error}`,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_PLUGIN_API,
    };
  }
  const pluginApiRange = pluginApiRangeCheck.range;
  if (pluginApiRange && !satisfiesPluginApiRange(params.currentHostVersion, pluginApiRange)) {
    return {
      ok: false,
      error: `plugin "${params.pluginId}" requires plugin API ${pluginApiRange}, but this OpenClaw runtime exposes ${params.currentHostVersion}. Upgrade OpenClaw or install a compatible plugin version and retry.`,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
    };
  }

  return null;
}

function validateOpenClawPackageInstallCompatibility(params: {
  runtime: PluginInstallRuntime;
  pluginId: string;
  packageMetadata?: OpenClawPackageManifest;
}): PluginInstallFailureResult | null {
  const currentHostVersion = params.runtime.resolveCompatibilityHostVersion();
  const minHostVersionCheck = params.runtime.checkMinHostVersion({
    currentVersion: currentHostVersion,
    minHostVersion: params.packageMetadata?.install?.minHostVersion,
  });
  if (!minHostVersionCheck.ok) {
    if (minHostVersionCheck.kind === "invalid") {
      return {
        ok: false,
        error: `invalid package.json openclaw.install.minHostVersion: ${minHostVersionCheck.error}`,
        code: PLUGIN_INSTALL_ERROR_CODE.INVALID_MIN_HOST_VERSION,
      };
    }
    if (minHostVersionCheck.kind === "unknown_host_version") {
      return {
        ok: false,
        error: `plugin "${params.pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.`,
        code: PLUGIN_INSTALL_ERROR_CODE.UNKNOWN_HOST_VERSION,
      };
    }
    return {
      ok: false,
      error: `plugin "${params.pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}. Upgrade OpenClaw and retry.`,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION,
    };
  }

  return validateOpenClawPackageCompatibility({
    pluginId: params.pluginId,
    currentHostVersion,
    packageMetadata: params.packageMetadata,
  });
}

async function readOptionalPackageManifest(params: {
  runtime: PluginInstallRuntime;
  packageDir: string;
}): Promise<{ ok: true; manifest?: PackageManifest } | PluginInstallFailureResult> {
  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await params.runtime.fileExists(manifestPath))) {
    return { ok: true };
  }

  try {
    return {
      ok: true,
      manifest: await params.runtime.readJsonFile<PackageManifest>(manifestPath),
    };
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }
}

type PluginNpmIntegrityDriftParams = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

type PluginInstallPolicyRequest = {
  kind: "plugin-dir" | "plugin-archive" | "plugin-npm" | "plugin-git";
  requestedSpecifier?: string;
  source?: InstallPolicySource;
};

const defaultLogger: PluginInstallLogger = {};

function ensureOpenClawExtensions(params: { manifest: PackageManifest }):
  | {
      ok: true;
      entries: string[];
    }
  | {
      ok: false;
      error: string;
      code: PluginInstallErrorCode;
    } {
  const resolved = resolvePackageExtensionEntries(params.manifest);
  if (resolved.status === "missing") {
    return {
      ok: false,
      error: MISSING_EXTENSIONS_ERROR,
      code: PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS,
    };
  }
  if (resolved.status === "empty") {
    return {
      ok: false,
      error: "package.json openclaw.extensions is empty",
      code: PLUGIN_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_EXTENSIONS,
    };
  }
  if (resolved.status === "invalid") {
    return {
      ok: false,
      error: resolved.error,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_OPENCLAW_EXTENSIONS,
    };
  }
  return {
    ok: true,
    entries: resolved.entries,
  };
}

function isNpmPackageNotFoundMessage(error: string): boolean {
  const normalized = error.trim();
  if (normalized.startsWith("Package not found on npm:")) {
    return true;
  }
  return /E404|404 not found|not in this registry/i.test(normalized);
}

function compareNpmSemver(a: string, b: string): number {
  const releaseCmp = compareOpenClawReleaseVersions(a, b);
  if (releaseCmp !== null) {
    return releaseCmp;
  }
  return compareValidSemver(a, b) ?? 0;
}

type TrustedOfficialPrereleaseResolution =
  | { kind: "stable"; resolution: NpmSpecResolution }
  | { kind: "prerelease-only"; resolution: NpmSpecResolution }
  | { kind: "allow-prerelease-only" };

async function loadNpmPackageVersions(params: {
  packageName: string;
  timeoutMs: number;
}): Promise<string[] | null> {
  const versions = await runCommandWithTimeout(
    ["npm", "view", params.packageName, "versions", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs, 60_000),
      env: createNpmMetadataEnv(),
    },
  );
  if (versions.code !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(versions.stdout.trim());
  } catch {
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is string => typeof value === "string" && isExactSemverVersion(value),
  );
}

async function resolveTrustedOfficialPrereleaseResolution(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedPrereleaseVersion: string;
  timeoutMs: number;
  logger: PluginInstallLogger;
}): Promise<TrustedOfficialPrereleaseResolution | null> {
  if (!params.spec.name.startsWith("@openclaw/")) {
    return null;
  }
  const semverVersions = await loadNpmPackageVersions({
    packageName: params.spec.name,
    timeoutMs: params.timeoutMs,
  });
  if (!semverVersions) {
    return null;
  }
  const stableVersion = semverVersions
    .filter((value) => !isPrereleaseSemverVersion(value))
    .toSorted(compareNpmSemver)
    .at(-1);
  if (!stableVersion) {
    const prereleaseVersion = semverVersions
      .filter(isPrereleaseSemverVersion)
      .toSorted(compareNpmSemver)
      .at(-1);
    if (prereleaseVersion && semverVersions.every(isPrereleaseSemverVersion)) {
      if (prereleaseVersion !== params.resolvedPrereleaseVersion) {
        const prereleaseSpec = `${params.spec.name}@${prereleaseVersion}`;
        const metadataResult = await resolveNpmSpecMetadata({
          spec: prereleaseSpec,
          timeoutMs: params.timeoutMs,
        });
        if (!metadataResult.ok) {
          return null;
        }
        params.logger.warn?.(
          `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; using newest prerelease ${prereleaseSpec} because this trusted official OpenClaw package has no stable npm versions yet.`,
        );
        return { kind: "prerelease-only", resolution: metadataResult.metadata };
      }
      params.logger.warn?.(
        `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; allowing it because this trusted official OpenClaw package has no stable npm versions yet.`,
      );
      return { kind: "allow-prerelease-only" };
    }
    return null;
  }

  const stableSpec = `${params.spec.name}@${stableVersion}`;
  const metadataResult = await resolveNpmSpecMetadata({
    spec: stableSpec,
    timeoutMs: params.timeoutMs,
  });
  if (!metadataResult.ok) {
    return null;
  }
  params.logger.warn?.(
    `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; falling back to stable ${stableSpec} for this trusted official OpenClaw install.`,
  );
  return { kind: "stable", resolution: metadataResult.metadata };
}

function shouldResolveLatestCompatibleNpmVersion(spec: ParsedRegistryNpmSpec): boolean {
  return (
    spec.selectorKind === "none" ||
    (spec.selectorKind === "tag" && (spec.selector ?? "").toLowerCase() === "latest")
  );
}

function shouldResolveCompatiblePrereleaseNpmVersion(params: {
  spec: ParsedRegistryNpmSpec;
  currentVersion: string;
}): boolean {
  if (!isPrereleaseSemverVersion(params.currentVersion)) {
    return false;
  }
  if (params.spec.selectorKind === "none") {
    return true;
  }
  return (
    params.spec.selectorKind === "tag" && (params.spec.selector ?? "").toLowerCase() !== "latest"
  );
}

function resolvePrereleaseChannel(version: string): string | null {
  if (!isPrereleaseSemverVersion(version)) {
    return null;
  }
  const match = /^\s*v?\d+\.\d+\.\d+-([0-9A-Za-z]+)(?:[.-]|$)/.exec(version);
  return match?.[1]?.toLowerCase() ?? null;
}

function canResolveAroundCompatibilityError(error: PluginInstallFailureResult): boolean {
  return (
    error.code === PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION ||
    error.code === PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API
  );
}

function validateNpmResolutionCompatibility(params: {
  runtime: PluginInstallRuntime;
  parsedSpec: ParsedRegistryNpmSpec;
  expectedPluginId?: string;
  resolution: NpmSpecResolution;
}): PluginInstallFailureResult | null {
  return validateOpenClawPackageInstallCompatibility({
    runtime: params.runtime,
    pluginId: params.expectedPluginId ?? params.resolution.name ?? params.parsedSpec.name,
    packageMetadata: params.resolution.packageOpenClaw as OpenClawPackageManifest | undefined,
  });
}

async function resolveLatestCompatibleNpmResolution(params: {
  runtime: PluginInstallRuntime;
  parsedSpec: ParsedRegistryNpmSpec;
  expectedPluginId?: string;
  currentResolution: NpmSpecResolution;
  timeoutMs: number;
  logger: PluginInstallLogger;
}): Promise<NpmSpecResolution | null> {
  if (!params.currentResolution.version) {
    return null;
  }
  const currentVersion = params.currentResolution.version;
  const allowPrereleaseCandidates = shouldResolveCompatiblePrereleaseNpmVersion({
    spec: params.parsedSpec,
    currentVersion,
  });
  const prereleaseChannel = allowPrereleaseCandidates
    ? resolvePrereleaseChannel(currentVersion)
    : null;
  if (!shouldResolveLatestCompatibleNpmVersion(params.parsedSpec) && !allowPrereleaseCandidates) {
    return null;
  }

  const versions = await loadNpmPackageVersions({
    packageName: params.parsedSpec.name,
    timeoutMs: params.timeoutMs,
  });
  if (!versions) {
    return null;
  }

  const candidates = versions
    .filter((version) =>
      allowPrereleaseCandidates
        ? resolvePrereleaseChannel(version) === prereleaseChannel
        : !isPrereleaseSemverVersion(version),
    )
    .filter((version) => compareNpmSemver(version, currentVersion) < 0)
    .toSorted(compareNpmSemver)
    .toReversed();
  for (const version of candidates) {
    const spec = `${params.parsedSpec.name}@${version}`;
    const metadataResult = await resolveNpmSpecMetadata({
      spec,
      timeoutMs: params.timeoutMs,
    });
    if (!metadataResult.ok) {
      params.logger.warn?.(
        `Could not inspect ${spec} while looking for a compatible plugin version: ${metadataResult.error}`,
      );
      continue;
    }
    const compatibilityError = validateNpmResolutionCompatibility({
      runtime: params.runtime,
      parsedSpec: params.parsedSpec,
      expectedPluginId: params.expectedPluginId,
      resolution: metadataResult.metadata,
    });
    if (!compatibilityError) {
      params.logger.warn?.(
        `Resolved ${params.parsedSpec.raw} to ${params.currentResolution.resolvedSpec ?? currentVersion}, but that version is incompatible with this OpenClaw runtime; using newest compatible ${metadataResult.metadata.resolvedSpec ?? spec}.`,
      );
      return metadataResult.metadata;
    }
  }

  return null;
}

function buildDirectoryInstallResult(params: {
  pluginId: string;
  targetDir: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
}): InstallPluginResult {
  return {
    ok: true,
    pluginId: params.pluginId,
    targetDir: params.targetDir,
    manifestName: params.manifestName,
    version: params.version,
    extensions: params.extensions,
  };
}

function emitSuccessfulPluginInstallSecurityEvent(
  result: InstallPluginResult,
  params: {
    dryRun?: boolean;
    mode: "install" | "update";
    sourceFamily: PluginSecuritySourceFamily;
    trustedSourceLinkedOfficialInstall?: boolean;
  },
) {
  if (params.dryRun || !result.ok) {
    return;
  }
  emitPluginInstallSecurityEvent({
    pluginId: result.pluginId,
    mode: params.mode,
    sourceFamily: params.sourceFamily,
    extensionCount: result.extensions.length,
    hasVersion: Boolean(result.version),
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
}

function hasPackageRuntimeDependencies(manifest: PackageManifest): boolean {
  return (
    Object.keys(manifest.dependencies ?? {}).length > 0 ||
    Object.keys(manifest.optionalDependencies ?? {}).length > 0
  );
}

function buildBlockedInstallResult(params: {
  blocked: NonNullable<NonNullable<InstallSecurityScanResult>["blocked"]>;
}): Extract<InstallPluginResult, { ok: false }> {
  return {
    ok: false,
    error: params.blocked.reason,
    ...(params.blocked.code === "security_scan_failed"
      ? { code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED }
      : params.blocked.code === "security_scan_blocked"
        ? { code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED }
        : {}),
  };
}

async function rollbackManagedNpmPluginInstall(params: {
  npmRoot: string;
  packageName: string;
  targetDir: string;
  timeoutMs: number;
  logger: PluginInstallLogger;
  peerDependencySnapshot?: ManagedNpmRootPeerDependencySnapshot;
  snapshot?: ManagedNpmPluginInstallRollbackSnapshot;
}): Promise<void> {
  if (params.snapshot) {
    try {
      await restoreManagedNpmPluginInstallRollbackSnapshot({
        npmRoot: params.npmRoot,
        snapshot: params.snapshot,
      });
      await relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot: params.npmRoot,
        logger: params.logger,
      });
    } catch (error) {
      params.logger.warn?.(
        `Failed to restore managed npm plugin root after installing ${params.packageName}: ${String(error)}`,
      );
    }
    return;
  }

  try {
    await runCommandWithTimeout(
      [
        "npm",
        "uninstall",
        "--loglevel=error",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        params.packageName,
      ],
      {
        cwd: params.npmRoot,
        timeoutMs: Math.max(params.timeoutMs, 300_000),
        env: createSafeNpmInstallEnv(process.env, {
          legacyPeerDeps: true,
          npmConfigCwd: params.npmRoot,
          packageLock: true,
          quiet: true,
        }),
      },
    );
  } catch (error) {
    params.logger.warn?.(
      `Failed to run npm uninstall rollback for ${params.packageName}: ${String(error)}`,
    );
  }
  try {
    await fs.rm(params.targetDir, { recursive: true, force: true });
  } catch (error) {
    params.logger.warn?.(
      `Failed to remove failed plugin install directory ${params.targetDir}: ${String(error)}`,
    );
  }
  try {
    await removeManagedNpmRootDependency({
      npmRoot: params.npmRoot,
      packageName: params.packageName,
    });
  } catch (error) {
    params.logger.warn?.(
      `Failed to remove managed npm dependency ${params.packageName}: ${String(error)}`,
    );
  }
  if (params.peerDependencySnapshot) {
    try {
      const preRestorePeerDependencySnapshot = await readManagedNpmRootPeerDependencySnapshot({
        npmRoot: params.npmRoot,
      });
      const restoredPeerDependencyNames = new Set(
        params.peerDependencySnapshot.managedPeerDependencies,
      );
      const addedPeerDependencyNames =
        preRestorePeerDependencySnapshot.managedPeerDependencies.filter(
          (packageName) => !restoredPeerDependencyNames.has(packageName),
        );
      await restoreManagedNpmRootPeerDependencySnapshot({
        npmRoot: params.npmRoot,
        snapshot: params.peerDependencySnapshot,
      });
      const cleanupResult = await runCommandWithTimeout(
        [
          "npm",
          "install",
          "--omit=dev",
          "--omit=peer",
          "--loglevel=error",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        {
          cwd: params.npmRoot,
          timeoutMs: Math.max(params.timeoutMs, 300_000),
          env: createSafeNpmInstallEnv(process.env, {
            legacyPeerDeps: true,
            npmConfigCwd: params.npmRoot,
            packageLock: true,
            quiet: true,
          }),
        },
      );
      if (cleanupResult.code !== 0) {
        params.logger.warn?.(
          `npm install cleanup after rollback for ${params.packageName} exited ${cleanupResult.code}: ${cleanupResult.stderr.trim() || cleanupResult.stdout.trim()}`,
        );
        await Promise.all(
          addedPeerDependencyNames.map(async (packageName) => {
            try {
              await fs.rm(resolveManagedNpmRootPackageDir(params.npmRoot, packageName), {
                recursive: true,
                force: true,
              });
            } catch (error) {
              params.logger.warn?.(
                `Failed to remove rolled-back managed peer dependency ${packageName}: ${String(error)}`,
              );
            }
          }),
        );
      }
    } catch (error) {
      params.logger.warn?.(
        `Failed to restore managed npm peer dependencies after rollback for ${params.packageName}: ${String(error)}`,
      );
    }
  }
  if (params.packageName !== "openclaw") {
    try {
      await repairManagedNpmRootOpenClawPeer({
        npmRoot: params.npmRoot,
        timeoutMs: params.timeoutMs,
        logger: params.logger,
      });
    } catch (error) {
      params.logger.warn?.(
        `Failed to repair managed npm openclaw peer after rollback: ${String(error)}`,
      );
    }
  }
  try {
    await relinkOpenClawPeerDependenciesInManagedNpmRoot({
      npmRoot: params.npmRoot,
      logger: params.logger,
    });
  } catch (error) {
    params.logger.warn?.(
      `Failed to repair managed npm peer links after rollback for ${params.packageName}: ${String(error)}`,
    );
  }
}

type ManagedNpmPluginInstallRollbackSnapshot = {
  packageJson?: string;
  packageLockJson?: string;
  nodeModulesBackupDir?: string;
  tempDir: string;
};

type ManagedNpmRootPreparedDependency = {
  dependencySpec: string;
  rollback?: () => Promise<void>;
  cleanup?: () => Promise<void>;
};

type ManagedNpmProjectQuarantine = {
  quarantineDir: string;
  movedArtifactNames: string[];
};

type ManagedNpmRootPrepareDependencyResult =
  | ({ ok: true } & ManagedNpmRootPreparedDependency)
  | {
      ok: false;
      error: string;
    };

type ManagedNpmRootDependencySpecPreparation = (params: {
  npmRoot: string;
}) => Promise<ManagedNpmRootPrepareDependencyResult>;

async function resolveManagedNpmRootDependencySpecForInstall(params: {
  npmRoot: string;
  packageName: string;
  dependencySpec?: string;
  prepareDependencySpec?: ManagedNpmRootDependencySpecPreparation;
}): Promise<ManagedNpmRootPrepareDependencyResult> {
  if (params.prepareDependencySpec) {
    try {
      return await params.prepareDependencySpec({ npmRoot: params.npmRoot });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to prepare managed npm dependency for ${params.packageName}: ${String(error)}`,
      };
    }
  }
  if (params.dependencySpec === undefined) {
    return {
      ok: false,
      error: `missing managed npm dependency spec for ${params.packageName}`,
    };
  }
  return { ok: true, dependencySpec: params.dependencySpec };
}

async function rollbackManagedNpmRootPreparedDependency(params: {
  packageName: string;
  preparedDependency: ManagedNpmRootPreparedDependency;
  logger: PluginInstallLogger;
}) {
  if (!params.preparedDependency.rollback) {
    return;
  }
  try {
    await params.preparedDependency.rollback();
  } catch (error) {
    params.logger.warn?.(
      `Failed to roll back prepared managed npm dependency artifacts for ${params.packageName}: ${String(error)}`,
    );
  }
}

async function cleanupManagedNpmRootPreparedDependency(params: {
  packageName: string;
  preparedDependency: ManagedNpmRootPreparedDependency | undefined;
  logger: PluginInstallLogger;
}) {
  if (!params.preparedDependency?.cleanup) {
    return;
  }
  try {
    await params.preparedDependency.cleanup();
  } catch (error) {
    params.logger.warn?.(
      `Failed to clean up prepared managed npm dependency artifacts for ${params.packageName}: ${String(error)}`,
    );
  }
}

async function removeEmptyDirectoryIfPresent(dir: string) {
  try {
    await fs.rmdir(dir);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

async function readRollbackFileIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeOrRemoveRollbackFile(filePath: string, contents: string | undefined) {
  if (contents === undefined) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function createManagedNpmPluginInstallRollbackSnapshot(params: {
  npmRoot: string;
}): Promise<ManagedNpmPluginInstallRollbackSnapshot> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-plugin-rollback-"));
  let nodeModulesBackupDir: string | undefined;
  const nodeModulesDir = path.join(params.npmRoot, "node_modules");
  try {
    await fs.stat(nodeModulesDir);
    nodeModulesBackupDir = path.join(tempDir, "node_modules");
    await fs.cp(nodeModulesDir, nodeModulesBackupDir, {
      recursive: true,
      force: true,
      filter: (sourcePath) =>
        shouldCopyManagedNpmRollbackSnapshotEntry({
          nodeModulesDir,
          sourcePath,
        }),
      mode: rollbackSnapshotCopyMode,
      verbatimSymlinks: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  try {
    return {
      packageJson: await readRollbackFileIfPresent(path.join(params.npmRoot, "package.json")),
      packageLockJson: await readRollbackFileIfPresent(
        path.join(params.npmRoot, "package-lock.json"),
      ),
      ...(nodeModulesBackupDir ? { nodeModulesBackupDir } : {}),
      tempDir,
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function shouldCopyManagedNpmRollbackSnapshotEntry(params: {
  nodeModulesDir: string;
  sourcePath: string | URL;
}): Promise<boolean> {
  if (typeof params.sourcePath !== "string") {
    return true;
  }

  const relativeParts = path.relative(params.nodeModulesDir, params.sourcePath).split(path.sep);
  const isPluginLocalOpenClawPeer =
    (relativeParts.length === 3 &&
      relativeParts[1] === "node_modules" &&
      relativeParts[2] === "openclaw") ||
    (relativeParts.length === 4 &&
      relativeParts[0]?.startsWith("@") &&
      relativeParts[2] === "node_modules" &&
      relativeParts[3] === "openclaw");
  if (!isPluginLocalOpenClawPeer) {
    return true;
  }

  try {
    return !(await fs.lstat(params.sourcePath)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function restoreManagedNpmPluginInstallRollbackSnapshot(params: {
  npmRoot: string;
  snapshot: ManagedNpmPluginInstallRollbackSnapshot;
}) {
  const nodeModulesDir = path.join(params.npmRoot, "node_modules");
  await fs.rm(nodeModulesDir, { recursive: true, force: true });
  if (params.snapshot.nodeModulesBackupDir) {
    await fs.mkdir(params.npmRoot, { recursive: true });
    await fs.cp(params.snapshot.nodeModulesBackupDir, nodeModulesDir, {
      recursive: true,
      force: true,
      mode: rollbackSnapshotCopyMode,
      verbatimSymlinks: true,
    });
  }
  await writeOrRemoveRollbackFile(
    path.join(params.npmRoot, "package.json"),
    params.snapshot.packageJson,
  );
  await writeOrRemoveRollbackFile(
    path.join(params.npmRoot, "package-lock.json"),
    params.snapshot.packageLockJson,
  );
}

async function cleanupManagedNpmPluginInstallRollbackSnapshot(params: {
  snapshot: ManagedNpmPluginInstallRollbackSnapshot | undefined;
  logger: PluginInstallLogger;
}) {
  if (!params.snapshot) {
    return;
  }
  try {
    await fs.rm(params.snapshot.tempDir, { recursive: true, force: true });
  } catch (error) {
    params.logger.warn?.(
      `Failed to remove temporary managed npm rollback snapshot ${params.snapshot.tempDir}: ${String(error)}`,
    );
  }
}

function formatNpmCommandFailureOutput(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim();
}

function isManagedNpmProjectCorruptionInstallFailure(result: {
  stdout: string;
  stderr: string;
}): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    output.includes("ERR_INVALID_ARG_TYPE") &&
    output.includes('"from" argument') &&
    output.includes("Received undefined")
  );
}

function formatManagedNpmProjectQuarantineArtifacts(artifactNames: string[]): string {
  return artifactNames.length > 0 ? artifactNames.join(", ") : "no rebuild artifacts";
}

async function quarantineManagedNpmProjectRebuildArtifacts(params: {
  npmRoot: string;
}): Promise<ManagedNpmProjectQuarantine> {
  await fs.mkdir(params.npmRoot, { recursive: true });
  const quarantineParent = path.join(params.npmRoot, MANAGED_NPM_PROJECT_QUARANTINE_DIR);
  await fs.mkdir(quarantineParent, { recursive: true });
  const quarantineDir = await fs.mkdtemp(path.join(quarantineParent, "corrupt-"));
  const movedArtifactNames: string[] = [];
  for (const artifactName of MANAGED_NPM_PROJECT_REBUILD_ARTIFACTS) {
    const source = path.join(params.npmRoot, artifactName);
    try {
      await fs.rename(source, path.join(quarantineDir, artifactName));
      movedArtifactNames.push(artifactName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return { quarantineDir, movedArtifactNames };
}

function resolveInstalledNpmResolutionMismatch(params: {
  packageName: string;
  expected: NpmSpecResolution;
  installed: ManagedNpmRootInstalledDependency | null;
}): string | null {
  if (!params.installed) {
    return `npm install did not record package-lock metadata for ${params.packageName}`;
  }
  if (params.expected.version && params.installed.version !== params.expected.version) {
    return `npm install resolved ${params.packageName} to version ${params.installed.version ?? "unknown"}, expected ${params.expected.version}`;
  }
  if (params.expected.integrity && params.installed.integrity !== params.expected.integrity) {
    return `npm install resolved ${params.packageName} with integrity ${params.installed.integrity ?? "unknown"}, expected ${params.expected.integrity}`;
  }
  return null;
}

async function listManagedNpmRootPackageNames(npmRoot: string): Promise<Set<string>> {
  const nodeModulesDir = path.join(npmRoot, "node_modules");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }

  const packageNames = new Set<string>();
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".bin" || entry.name === "openclaw") {
      continue;
    }
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let scopedEntries: Dirent[];
      try {
        scopedEntries = await fs.readdir(scopeDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const scopedEntry of scopedEntries.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          packageNames.add(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      packageNames.add(entry.name);
    }
  }
  return packageNames;
}

function resolveManagedNpmRootPackageDir(npmRoot: string, packageName: string): string {
  return path.join(npmRoot, "node_modules", ...packageName.split("/"));
}

function resolveManagedNpmRootGenerationKey(params: {
  packageName: string;
  npmResolution: NpmSpecResolution;
}): string {
  return [
    params.npmResolution.name ?? params.packageName,
    params.npmResolution.version ?? "",
    params.npmResolution.resolvedSpec ?? "",
    params.npmResolution.integrity ?? "",
    params.npmResolution.shasum ?? "",
  ].join("\n");
}

function resolveManagedNpmRootForInstall(params: {
  npmBaseDir: string;
  packageName: string;
  npmResolution: NpmSpecResolution;
  useGeneration: boolean;
}): string {
  if (!params.useGeneration) {
    return resolvePluginNpmProjectDir({
      npmDir: params.npmBaseDir,
      packageName: params.packageName,
    });
  }
  return resolvePluginNpmGenerationProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
    generationKey: resolveManagedNpmRootGenerationKey({
      packageName: params.packageName,
      npmResolution: params.npmResolution,
    }),
  });
}

function resolveManagedNpmInstallRoot(params: {
  npmBaseDir: string;
  packageName: string;
  npmResolution: NpmSpecResolution;
  useGeneration: boolean;
}): string {
  const generationKey = resolveManagedNpmRootGenerationKey({
    packageName: params.packageName,
    npmResolution: params.npmResolution,
  });
  const npmRoot = resolveManagedNpmRootForInstall(params);
  const installRoot = resolveManagedNpmRootPackageDir(npmRoot, params.packageName);
  if (!hasRetainedManagedNpmInstallMarker(installRoot)) {
    return npmRoot;
  }
  // Never mutate a retained tree: an older process may still hold lazy imports
  // rooted there. A fresh activation root keeps that module graph importable.
  return resolvePluginNpmGenerationProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
    generationKey: `${generationKey}\nactivation\n${randomUUID()}`,
  });
}

async function listManagedNpmPackageDirsForPackage(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  npmBaseDir: string;
  packageName: string;
}): Promise<string[]> {
  const packageDirs: string[] = [];
  const legacyProjectRoot = resolvePluginNpmProjectDir({
    npmDir: params.npmBaseDir,
    packageName: params.packageName,
  });
  const legacyPackageDir = resolveManagedNpmRootPackageDir(legacyProjectRoot, params.packageName);
  if (await params.runtime.fileExists(legacyPackageDir)) {
    packageDirs.push(legacyPackageDir);
  }
  const projectsDir = path.dirname(legacyProjectRoot);
  const generationPrefix = resolvePluginNpmGenerationProjectDirPrefix(params.packageName);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return packageDirs;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(generationPrefix)) {
      continue;
    }
    const packageDir = resolveManagedNpmRootPackageDir(
      path.join(projectsDir, entry.name),
      params.packageName,
    );
    if (await params.runtime.fileExists(packageDir)) {
      packageDirs.push(packageDir);
    }
  }
  return packageDirs;
}

async function resolveManagedNpmGenerationUseForInstall(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  npmBaseDir: string;
  packageName: string;
  requestedMode: "install" | "update";
  npmResolution?: NpmSpecResolution;
}): Promise<"none" | "update" | "retained-install"> {
  const packageDirs = await listManagedNpmPackageDirsForPackage({
    runtime: params.runtime,
    npmBaseDir: params.npmBaseDir,
    packageName: params.packageName,
  });
  const hasNonRetainedPackageDir = packageDirs.some(
    (packageDir) => !hasRetainedManagedNpmInstallMarker(packageDir),
  );
  if (packageDirs.length > 0 && !hasNonRetainedPackageDir) {
    return "retained-install";
  }
  const generationUse =
    params.requestedMode === "update" && hasNonRetainedPackageDir ? "update" : "none";
  if (params.npmResolution) {
    const candidateRoot = resolveManagedNpmRootForInstall({
      npmBaseDir: params.npmBaseDir,
      packageName: params.packageName,
      npmResolution: params.npmResolution,
      useGeneration: generationUse !== "none",
    });
    const candidatePackageDir = resolveManagedNpmRootPackageDir(candidateRoot, params.packageName);
    if (hasRetainedManagedNpmInstallMarker(candidatePackageDir)) {
      return "retained-install";
    }
  }
  if (params.requestedMode === "update") {
    return hasNonRetainedPackageDir ? "update" : "none";
  }
  return "none";
}

function resolveRequiredPlatformPackageNames(
  packageMetadata?: OpenClawPackageManifest,
): { ok: true; packageNames: string[] } | { ok: false; error: string } {
  const raw = packageMetadata?.install?.requiredPlatformPackages as unknown;
  if (raw === undefined) {
    return { ok: true, packageNames: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: "package.json openclaw.install.requiredPlatformPackages must be an array",
    };
  }
  const packageNames = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      return {
        ok: false,
        error:
          "package.json openclaw.install.requiredPlatformPackages must contain only npm package names",
      };
    }
    const specError = validateRegistryNpmSpec(value);
    const parsed = parseRegistryNpmSpec(value);
    if (specError || !parsed || parsed.selectorKind !== "none") {
      return {
        ok: false,
        error: `package.json openclaw.install.requiredPlatformPackages contains invalid package name: ${value}`,
      };
    }
    packageNames.add(parsed.name);
  }
  return { ok: true, packageNames: [...packageNames] };
}

async function listNewManagedNpmRootPackageDirs(params: {
  beforeInstallPackageNames: Set<string>;
  npmRoot: string;
}): Promise<string[]> {
  const afterInstallPackageNames = await listManagedNpmRootPackageNames(params.npmRoot);
  return [...afterInstallPackageNames]
    .filter((packageName) => !params.beforeInstallPackageNames.has(packageName))
    .map((packageName) => resolveManagedNpmRootPackageDir(params.npmRoot, packageName))
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveTrustedNpmPackPackageName(packageName: string | undefined):
  | {
      ok: true;
      packageName: string;
    }
  | {
      ok: false;
      error: string;
      code: PluginInstallErrorCode;
    } {
  if (!packageName) {
    return {
      ok: false,
      error: "npm pack metadata missing package name",
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }
  const specError = validateRegistryNpmSpec(packageName);
  const parsedSpec = parseRegistryNpmSpec(packageName);
  if (specError || !parsedSpec || parsedSpec.selectorKind !== "none") {
    return {
      ok: false,
      error: `unsupported npm pack package name: ${packageName}`,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }
  return { ok: true, packageName: parsedSpec.name };
}

async function installPluginFromManagedNpmRoot(
  params: InstallSafetyOverrides & {
    packageName: string;
    dependencySpec?: string;
    prepareDependencySpec?: ManagedNpmRootDependencySpecPreparation;
    displaySpec: string;
    installPolicyRequest: PluginInstallPolicyRequest;
    npmResolution: NpmSpecResolution;
    policyPreflightSourcePath?: string;
    policyPreflightSourcePathKind?: "file" | "directory";
    skipPolicyPreflight?: boolean;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    integrityDrift?: NpmIntegrityDrift;
  },
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedPluginId = params.expectedPluginId;
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const generationUse = await resolveManagedNpmGenerationUseForInstall({
    runtime,
    npmBaseDir,
    packageName: params.packageName,
    requestedMode: mode,
    npmResolution: params.npmResolution,
  });
  const npmRoot = resolveManagedNpmInstallRoot({
    npmBaseDir,
    packageName: params.packageName,
    npmResolution: params.npmResolution,
    useGeneration: generationUse !== "none",
  });
  const installRoot = resolveManagedNpmRootPackageDir(npmRoot, params.packageName);
  const targetMode =
    generationUse === "retained-install" && hasRetainedManagedNpmInstallMarker(installRoot)
      ? "update"
      : await resolveEffectiveInstallMode({
          runtime,
          requestedMode: mode,
          targetPath: installRoot,
        });
  const policyMode =
    generationUse === "update"
      ? "update"
      : generationUse === "retained-install"
        ? "install"
        : targetMode;
  const availability = await ensureInstallTargetAvailableForMode({
    runtime,
    targetPath: installRoot,
    mode: targetMode,
  });
  if (!availability.ok) {
    return availability;
  }

  if (!params.skipPolicyPreflight) {
    const preflightPolicyResult = await runInstallSourceScan({
      subject: `Plugin "${expectedPluginId ?? params.packageName}"`,
      pluginId: expectedPluginId ?? params.packageName,
      mode: policyMode,
      sourceFamily: sourceFamilyForInstallPolicySource(params.installPolicyRequest.source, "npm"),
      scan: async () =>
        await preflightPluginNpmInstallPolicy({
          config: params.config,
          logger,
          mode: policyMode,
          packageName: params.packageName,
          ...(expectedPluginId ? { pluginId: expectedPluginId } : {}),
          requestedSpecifier: params.installPolicyRequest.requestedSpecifier ?? params.displaySpec,
          source: params.installPolicyRequest.source,
          sourcePath: params.policyPreflightSourcePath ?? npmRoot,
          sourcePathKind: params.policyPreflightSourcePathKind ?? "directory",
        }),
    });
    if (preflightPolicyResult) {
      return preflightPolicyResult;
    }
  }

  if (dryRun) {
    return {
      ok: true,
      pluginId: expectedPluginId ?? params.packageName,
      targetDir: installRoot,
      extensions: [],
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  }

  let rollbackSnapshot: ManagedNpmPluginInstallRollbackSnapshot;
  let preparedDependency: ManagedNpmRootPreparedDependency | undefined;
  try {
    rollbackSnapshot = await createManagedNpmPluginInstallRollbackSnapshot({ npmRoot });
  } catch (error) {
    return {
      ok: false,
      error: `Failed to snapshot managed npm root before installing ${params.packageName}: ${String(error)}`,
    };
  }

  const runManagedNpmInstall = async (
    prepared: ManagedNpmRootPreparedDependency,
  ): Promise<InstallPluginResult> => {
    logger.info?.(`Installing ${params.displaySpec} into ${npmRoot}…`);
    if (params.packageName !== "openclaw") {
      const repairedOpenClawPeer = await repairManagedNpmRootOpenClawPeer({
        npmRoot,
        timeoutMs,
        logger,
      });
      if (repairedOpenClawPeer) {
        logger.info?.(`Repaired stale openclaw peer dependency in ${npmRoot}`);
      }
    }
    let preInstallRootPackageNames = await listManagedNpmRootPackageNames(npmRoot);
    const managedOverrides = await readOpenClawManagedNpmRootOverrides();
    const rollbackPeerDependencySnapshot = await readManagedNpmRootPeerDependencySnapshot({
      npmRoot,
    });
    const rollbackFailedManagedNpmInstall = async (
      failure: Extract<InstallPluginResult, { ok: false }>,
    ): Promise<Extract<InstallPluginResult, { ok: false }>> => {
      await rollbackManagedNpmPluginInstall({
        npmRoot,
        packageName: params.packageName,
        targetDir: installRoot,
        timeoutMs,
        logger,
        peerDependencySnapshot: rollbackPeerDependencySnapshot,
        snapshot: rollbackSnapshot,
      });
      await rollbackManagedNpmRootPreparedDependency({
        packageName: params.packageName,
        preparedDependency: prepared,
        logger,
      });
      return failure;
    };
    const rollbackFailedManagedNpmInstallAfterQuarantine = async (
      failure: Extract<InstallPluginResult, { ok: false }>,
    ): Promise<Extract<InstallPluginResult, { ok: false }>> => {
      await rollbackManagedNpmPluginInstall({
        npmRoot,
        packageName: params.packageName,
        targetDir: installRoot,
        timeoutMs,
        logger,
        peerDependencySnapshot: rollbackPeerDependencySnapshot,
      });
      await rollbackManagedNpmRootPreparedDependency({
        packageName: params.packageName,
        preparedDependency: prepared,
        logger,
      });
      return failure;
    };
    const syncManagedPeerDependenciesForInstall = async (options?: {
      omitUnsupportedManagedOverrides?: boolean;
    }): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> => {
      try {
        return {
          ok: true,
          changed: await syncManagedNpmRootPeerDependencies({
            npmRoot,
            managedOverrides,
            omitUnsupportedManagedOverrides: options?.omitUnsupportedManagedOverrides,
            timeoutMs,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: `npm peer dependency planning failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: params.packageName,
      dependencySpec: prepared.dependencySpec,
      managedOverrides,
    });
    const initialPeerSync = await syncManagedPeerDependenciesForInstall();
    if (!initialPeerSync.ok) {
      return await rollbackFailedManagedNpmInstall({ ok: false, error: initialPeerSync.error });
    }
    const npmInstallArgs = [
      "npm",
      ...createSafeNpmInstallArgs({
        omitDev: true,
        omitPeer: true,
        loglevel: "error",
        legacyPeerDeps: true,
        noAudit: true,
        noFund: true,
      }),
    ];
    const npmInstallOptions = {
      cwd: npmRoot,
      timeoutMs: Math.max(timeoutMs, 300_000),
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: true,
        npmConfigCwd: npmRoot,
        packageLock: true,
        quiet: true,
      }),
    };
    let install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    let omitUnsupportedManagedOverrides = false;
    if (install.code !== 0 && isNpmAliasOverrideComparatorError(install)) {
      logger.warn?.(
        "npm rejected managed npm alias overrides; retrying plugin install without alias overrides for this npm version.",
      );
      omitUnsupportedManagedOverrides = true;
      await upsertManagedNpmRootDependency({
        npmRoot,
        packageName: params.packageName,
        dependencySpec: prepared.dependencySpec,
        managedOverrides,
        omitUnsupportedManagedOverrides: true,
      });
      const aliasRetryPeerSync = await syncManagedPeerDependenciesForInstall({
        omitUnsupportedManagedOverrides: true,
      });
      if (!aliasRetryPeerSync.ok) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: aliasRetryPeerSync.error,
        });
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    }
    if (install.code !== 0 && isManagedNpmProjectCorruptionInstallFailure(install)) {
      const originalError = formatNpmCommandFailureOutput(install);
      let quarantine: ManagedNpmProjectQuarantine;
      try {
        quarantine = await quarantineManagedNpmProjectRebuildArtifacts({ npmRoot });
      } catch (error) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `npm install failed with a managed npm project corruption signature, but OpenClaw could not quarantine ${npmRoot} for rebuild: ${String(error)}. Original npm error: ${originalError}`,
        });
      }
      logger.warn?.(
        `npm reported a managed npm project corruption signature; quarantined ${formatManagedNpmProjectQuarantineArtifacts(quarantine.movedArtifactNames)} at ${quarantine.quarantineDir} and rebuilding once before retrying.`,
      );
      preInstallRootPackageNames = await listManagedNpmRootPackageNames(npmRoot);
      const recoveryPeerSync = await syncManagedPeerDependenciesForInstall({
        omitUnsupportedManagedOverrides,
      });
      if (!recoveryPeerSync.ok) {
        return await rollbackFailedManagedNpmInstallAfterQuarantine({
          ok: false,
          error: `managed npm project recovery failed after quarantining ${formatManagedNpmProjectQuarantineArtifacts(quarantine.movedArtifactNames)} at ${quarantine.quarantineDir}: ${recoveryPeerSync.error}. Original npm error: ${originalError}`,
        });
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
      if (install.code !== 0) {
        return await rollbackFailedManagedNpmInstallAfterQuarantine({
          ok: false,
          error: `npm install failed after managed npm project recovery (quarantine: ${quarantine.quarantineDir}): ${formatNpmCommandFailureOutput(install)}. Original npm error: ${originalError}`,
        });
      }
    }
    if (install.code !== 0) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `npm install failed: ${formatNpmCommandFailureOutput(install)}`,
      });
    }
    let settledManagedPeerDependencies = false;
    for (let peerSyncPass = 0; peerSyncPass < 10; peerSyncPass += 1) {
      const peerSync = await syncManagedPeerDependenciesForInstall({
        omitUnsupportedManagedOverrides,
      });
      if (!peerSync.ok) {
        return await rollbackFailedManagedNpmInstall({ ok: false, error: peerSync.error });
      }
      const syncedPeerDependencies = peerSync.changed;
      if (!syncedPeerDependencies) {
        settledManagedPeerDependencies = true;
        break;
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
      if (install.code !== 0) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `npm install failed after syncing managed peer dependencies: ${install.stderr.trim() || install.stdout.trim()}`,
        });
      }
    }
    if (!settledManagedPeerDependencies) {
      const peerSync = await syncManagedPeerDependenciesForInstall({
        omitUnsupportedManagedOverrides,
      });
      if (!peerSync.ok) {
        return await rollbackFailedManagedNpmInstall({ ok: false, error: peerSync.error });
      }
      settledManagedPeerDependencies = !peerSync.changed;
    }
    if (!settledManagedPeerDependencies) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error:
          "npm install could not settle managed peer dependencies after 10 sync passes; refusing to leave a partially reconciled plugin dependency tree.",
      });
    }
    const packageManifestResult = await readOptionalPackageManifest({
      runtime,
      packageDir: installRoot,
    });
    if (!packageManifestResult.ok) {
      return await rollbackFailedManagedNpmInstall(packageManifestResult);
    }
    const requiredPlatformPackageNames = resolveRequiredPlatformPackageNames(
      packageManifestResult.manifest
        ? runtime.getPackageManifestMetadata(packageManifestResult.manifest)
        : undefined,
    );
    if (!requiredPlatformPackageNames.ok) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: requiredPlatformPackageNames.error,
      });
    }
    let omittedPlatformPackages: Awaited<ReturnType<typeof listMissingRequiredPlatformPackages>>;
    try {
      omittedPlatformPackages = await listMissingRequiredPlatformPackages({
        npmRoot,
        requiredPackageNames: requiredPlatformPackageNames.packageNames,
      });
    } catch (error) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `Failed to verify platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
      });
    }
    if (omittedPlatformPackages.length > 0) {
      const omittedPlatformPackageNames = omittedPlatformPackages.map((entry) => entry.name);
      logger.warn?.(
        `npm omitted current-platform package(s) ${omittedPlatformPackageNames.join(", ")}; retrying once with a fresh cache.`,
      );
      let freshCacheDir: string | undefined;
      try {
        freshCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-cache-"));
        install = await runCommandWithTimeout(npmInstallArgs, {
          ...npmInstallOptions,
          env: {
            ...npmInstallOptions.env,
            NPM_CONFIG_CACHE: freshCacheDir,
            npm_config_cache: freshCacheDir,
          },
        });
      } catch (error) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `Failed to repair omitted current-platform package(s) ${omittedPlatformPackageNames.join(", ")}: ${String(error)}`,
        });
      } finally {
        if (freshCacheDir) {
          try {
            await fs.rm(freshCacheDir, { recursive: true, force: true });
          } catch (error) {
            logger.warn?.(
              `Failed to remove temporary npm cache ${freshCacheDir}: ${String(error)}`,
            );
          }
        }
      }
      if (install.code !== 0) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `npm install failed while repairing omitted current-platform package(s) ${omittedPlatformPackageNames.join(", ")}: ${formatNpmCommandFailureOutput(install)}`,
        });
      }
      let stillOmittedPlatformPackages: typeof omittedPlatformPackages;
      try {
        stillOmittedPlatformPackages = await listMissingRequiredPlatformPackages({
          npmRoot,
          requiredPackageNames: requiredPlatformPackageNames.packageNames,
        });
      } catch (error) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `Failed to verify repaired platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
        });
      }
      if (stillOmittedPlatformPackages.length > 0) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `npm install reported success but omitted required current-platform package(s): ${stillOmittedPlatformPackages.map((entry) => entry.name).join(", ")}`,
        });
      }
    }
    if (params.packageName !== "openclaw") {
      const repairedOpenClawPeer = await repairManagedNpmRootOpenClawPeer({
        npmRoot,
        timeoutMs,
        logger,
      });
      if (repairedOpenClawPeer) {
        logger.info?.(`Repaired stale openclaw peer dependency in ${npmRoot} after npm install`);
      }
    }
    try {
      await relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        logger,
      });
    } catch (error) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `Failed to repair openclaw peer links after npm install: ${String(error)}`,
      });
    }
    if (installedPackageNeedsOpenClawPeerLinkRepair(installRoot)) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: formatUnresolvedOpenClawPeerLinkError(params.packageName),
      });
    }

    let installedDependency: ManagedNpmRootInstalledDependency | null;
    try {
      installedDependency = await readManagedNpmRootInstalledDependency({
        npmRoot,
        packageName: params.packageName,
      });
    } catch (error) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `Failed to verify npm install metadata for ${params.packageName}: ${String(error)}`,
      });
    }
    const resolutionMismatch = resolveInstalledNpmResolutionMismatch({
      packageName: params.packageName,
      expected: params.npmResolution,
      installed: installedDependency,
    });
    if (resolutionMismatch) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: resolutionMismatch,
      });
    }

    const newRootPackageDirs = await listNewManagedNpmRootPackageDirs({
      beforeInstallPackageNames: preInstallRootPackageNames,
      npmRoot,
    });
    const result = await installPluginFromInstalledPackageDirInternal({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      config: params.config,
      additionalDependencyPackageDirs: newRootPackageDirs,
      packageDir: installRoot,
      dependencyScanRootDir: npmRoot,
      logger,
      expectedPluginId,
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
      mode: policyMode,
      installPolicyRequest: params.installPolicyRequest,
      emitSuccessSecurityEvent: false,
    });
    if (!result.ok) {
      return await rollbackFailedManagedNpmInstall(result);
    }
    return {
      ...result,
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  };

  try {
    const dependencyResult = await resolveManagedNpmRootDependencySpecForInstall({
      npmRoot,
      packageName: params.packageName,
      dependencySpec: params.dependencySpec,
      prepareDependencySpec: params.prepareDependencySpec,
    });
    if (!dependencyResult.ok) {
      return dependencyResult;
    }
    preparedDependency = dependencyResult;
    return await runManagedNpmInstall(preparedDependency);
  } finally {
    await cleanupManagedNpmRootPreparedDependency({
      packageName: params.packageName,
      preparedDependency,
      logger,
    });
    await cleanupManagedNpmPluginInstallRollbackSnapshot({
      snapshot: rollbackSnapshot,
      logger,
    });
  }
}

async function stageNpmPackArchiveInManagedRoot(params: {
  archivePath: string;
  npmRoot: string;
  packageName: string;
  version?: string;
  integrity?: string;
  shasum?: string;
  tarballName: string;
}): Promise<
  {
    stableArchivePath: string;
  } & ManagedNpmRootPreparedDependency
> {
  const archiveStoreDir = path.join(params.npmRoot, MANAGED_NPM_PACK_ARCHIVE_DIR);
  const identity = params.integrity ?? params.shasum ?? params.tarballName;
  const identitySlug = sha256HexPrefix(identity, 16);
  const packageSlug = safePluginInstallFileName(params.packageName) || "plugin";
  const versionSlug = safePluginInstallFileName(params.version ?? "pack") || "pack";
  const archiveFileName = `${packageSlug}-${versionSlug}-${identitySlug}.tgz`;
  const stableArchivePath = path.join(archiveStoreDir, archiveFileName);
  const tempArchivePath = path.join(
    archiveStoreDir,
    `.${archiveFileName}.${process.pid}.${Date.now()}.tmp`,
  );
  let archiveStoreExisted = true;
  let backupTempDir: string | undefined;
  let previousArchiveBackupPath: string | undefined;
  const cleanupBackup = async () => {
    if (!backupTempDir) {
      return;
    }
    const tempDir = backupTempDir;
    backupTempDir = undefined;
    previousArchiveBackupPath = undefined;
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  try {
    await fs.access(archiveStoreDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    archiveStoreExisted = false;
  }

  try {
    await fs.access(stableArchivePath);
    backupTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-pack-archive-"));
    previousArchiveBackupPath = path.join(backupTempDir, archiveFileName);
    await fs.copyFile(stableArchivePath, previousArchiveBackupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await cleanupBackup();
      throw error;
    }
  }

  try {
    await fs.mkdir(archiveStoreDir, { recursive: true });
    await fs.copyFile(params.archivePath, tempArchivePath);
    await fs.rename(tempArchivePath, stableArchivePath);
  } catch (error) {
    await fs.rm(tempArchivePath, { force: true });
    await cleanupBackup();
    if (!archiveStoreExisted) {
      await removeEmptyDirectoryIfPresent(archiveStoreDir);
    }
    throw error;
  }

  return {
    stableArchivePath,
    dependencySpec: `file:./${path.posix.join(MANAGED_NPM_PACK_ARCHIVE_DIR, archiveFileName)}`,
    rollback: async () => {
      if (previousArchiveBackupPath) {
        await fs.mkdir(archiveStoreDir, { recursive: true });
        await fs.copyFile(previousArchiveBackupPath, stableArchivePath);
      } else {
        await fs.rm(stableArchivePath, { force: true });
      }
      await cleanupBackup();
      if (!archiveStoreExisted) {
        await removeEmptyDirectoryIfPresent(archiveStoreDir);
      }
    },
    cleanup: cleanupBackup,
  };
}

type PackageInstallCommonParams = InstallSafetyOverrides & {
  extensionsDir?: string;
  npmDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  requirePluginManifest?: boolean;
  allowSourceTypeScriptEntries?: boolean;
  installPolicyRequest?: PluginInstallPolicyRequest;
};

type InternalPackageInstallCommonParams = PackageInstallCommonParams & {
  onEffectiveMode?: (mode: "install" | "update") => void;
};

function pickPackageInstallCommonParams(
  params: InternalPackageInstallCommonParams,
): InternalPackageInstallCommonParams {
  return {
    config: params.config,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    extensionsDir: params.extensionsDir,
    npmDir: params.npmDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedPluginId: params.expectedPluginId,
    requirePluginManifest: params.requirePluginManifest,
    allowSourceTypeScriptEntries: params.allowSourceTypeScriptEntries,
    installPolicyRequest: params.installPolicyRequest,
    onEffectiveMode: params.onEffectiveMode,
  };
}

function installPolicyRequestForPath(
  params: PackageInstallCommonParams & { path: string },
  kind: PluginInstallPolicyRequest["kind"],
): PluginInstallPolicyRequest {
  const requestKind =
    params.installPolicyRequest?.kind === "plugin-git" && kind === "plugin-dir"
      ? "plugin-git"
      : kind;
  return {
    kind: requestKind,
    requestedSpecifier: params.installPolicyRequest?.requestedSpecifier ?? params.path,
    source: params.installPolicyRequest?.source ?? localPluginInstallPolicySource(requestKind),
  };
}

function localPluginInstallPolicySource(kind: PluginInstallPolicyRequest["kind"]) {
  if (kind === "plugin-archive") {
    return { kind: "archive", authority: "user", mutable: true, network: false } as const;
  }
  if (kind === "plugin-git") {
    return { kind: "git", authority: "third-party", mutable: true, network: true } as const;
  }
  return { kind: "local-path", authority: "user", mutable: true, network: false } as const;
}

function sourceFamilyForInstallPolicyKind(
  kind: PluginInstallPolicyRequest["kind"] | undefined,
  fallback: PluginSecuritySourceFamily,
): PluginSecuritySourceFamily {
  switch (kind) {
    case "plugin-archive":
      return "archive";
    case "plugin-dir":
      return "directory";
    case "plugin-git":
      return "git";
    case "plugin-npm":
      return "npm";
    case undefined:
      return fallback;
  }
  return fallback;
}

function sourceFamilyForInstallPolicySource(
  source: InstallPolicySource | undefined,
  fallback: PluginSecuritySourceFamily,
): PluginSecuritySourceFamily {
  switch (source?.kind) {
    case "archive":
      return "archive";
    case "file":
      return "file";
    case "git":
      return "git";
    case "npm":
      return "npm";
    case "bundled":
    case "clawhub":
    case "local-path":
    case "managed":
    case "upload":
    case "workspace":
    case undefined:
      return fallback;
  }
  return fallback;
}

type PreparedInstallTarget = {
  targetPath: string;
  effectiveMode: "install" | "update";
};

async function ensureInstallTargetAvailableForMode(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  targetPath: string;
  mode: "install" | "update";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return await params.runtime.ensureInstallTargetAvailable({
    mode: params.mode,
    targetDir: params.targetPath,
    alreadyExistsError: `plugin already exists: ${params.targetPath} (delete it first)`,
  });
}

async function resolvePreparedDirectoryInstallTarget(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  pluginId: string;
  extensionsDir?: string;
  requestedMode: "install" | "update";
  nameEncoder?: (pluginId: string) => string;
}): Promise<{ ok: true; target: PreparedInstallTarget } | { ok: false; error: string }> {
  const targetDirResult = await resolvePluginInstallTarget({
    runtime: params.runtime,
    pluginId: params.pluginId,
    extensionsDir: params.extensionsDir,
    nameEncoder: params.nameEncoder,
  });
  if (!targetDirResult.ok) {
    return targetDirResult;
  }
  return {
    ok: true,
    target: {
      targetPath: targetDirResult.targetDir,
      effectiveMode: await resolveEffectiveInstallMode({
        runtime: params.runtime,
        requestedMode: params.requestedMode,
        targetPath: targetDirResult.targetDir,
      }),
    },
  };
}

async function runInstallSourceScan(params: {
  subject: string;
  pluginId?: string;
  mode?: "install" | "update";
  sourceFamily?: PluginSecuritySourceFamily;
  scan: () => Promise<InstallSecurityScanResult | undefined>;
}): Promise<Extract<InstallPluginResult, { ok: false }> | null> {
  try {
    const scanResult = await params.scan();
    if (scanResult?.blocked) {
      const reason =
        scanResult.blocked.code === "security_scan_failed"
          ? "security_scan_failed"
          : "security_scan_blocked";
      emitPluginAuditSecurityEvent({
        outcome: pluginAuditOutcomeForReason(reason),
        reason,
        pluginId: params.pluginId,
        mode: params.mode,
        sourceFamily: params.sourceFamily,
      });
      return buildBlockedInstallResult({ blocked: scanResult.blocked });
    }
    return null;
  } catch (err) {
    emitPluginAuditSecurityEvent({
      outcome: "error",
      reason: "security_scan_failed",
      pluginId: params.pluginId,
      mode: params.mode,
      sourceFamily: params.sourceFamily,
    });
    return {
      ok: false,
      error: `${params.subject} installation blocked: code safety scan failed (${String(err)}). Run "openclaw security audit --deep" for details.`,
      code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED,
    };
  }
}

async function installPluginDirectoryIntoExtensions(params: {
  sourceDir: string;
  pluginId: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
  targetDir?: string;
  extensionsDir?: string;
  logger: PluginInstallLogger;
  timeoutMs: number;
  mode: "install" | "update";
  dryRun: boolean;
  copyErrorPrefix: string;
  hasDeps: boolean;
  sourceHardlinks?: "package-manager" | "reject";
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => Promise<void>;
  afterInstall?: (
    installedDir: string,
  ) => Promise<Extract<InstallPluginResult, { ok: false }> | null>;
  nameEncoder?: (pluginId: string) => string;
}): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  let targetDir = params.targetDir;
  if (!targetDir) {
    const targetDirResult = await resolvePluginInstallTarget({
      runtime,
      pluginId: params.pluginId,
      extensionsDir: params.extensionsDir,
      nameEncoder: params.nameEncoder,
    });
    if (!targetDirResult.ok) {
      return { ok: false, error: targetDirResult.error };
    }
    targetDir = targetDirResult.targetDir;
  }
  const availability = await ensureInstallTargetAvailableForMode({
    runtime,
    targetPath: targetDir,
    mode: params.mode,
  });
  if (!availability.ok) {
    return availability;
  }

  if (params.dryRun) {
    return buildDirectoryInstallResult({
      pluginId: params.pluginId,
      targetDir,
      manifestName: params.manifestName,
      version: params.version,
      extensions: params.extensions,
    });
  }

  const installRes = await runtime.installPackageDir({
    sourceDir: params.sourceDir,
    targetDir,
    mode: params.mode,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    copyErrorPrefix: params.copyErrorPrefix,
    hasDeps: params.hasDeps,
    sourceHardlinks: params.sourceHardlinks ?? "reject",
    depsLogMessage: params.depsLogMessage,
    afterCopy: params.afterCopy,
    afterInstall: async (installedDir) => {
      const postInstallResult = await params.afterInstall?.(installedDir);
      if (!postInstallResult) {
        return { ok: true as const };
      }
      return {
        ok: false as const,
        error: postInstallResult.error,
        ...(postInstallResult.code ? { code: postInstallResult.code } : {}),
      };
    },
  });
  if (!installRes.ok) {
    return {
      ok: false,
      error: installRes.error,
      ...(installRes.code ? { code: installRes.code as PluginInstallErrorCode } : {}),
    };
  }

  return buildDirectoryInstallResult({
    pluginId: params.pluginId,
    targetDir,
    manifestName: params.manifestName,
    version: params.version,
    extensions: params.extensions,
  });
}

async function resolvePluginInstallTarget(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  pluginId: string;
  extensionsDir?: string;
  nameEncoder?: (pluginId: string) => string;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : resolveDefaultPluginExtensionsDir();
  return await params.runtime.resolveCanonicalInstallTarget({
    baseDir: extensionsDir,
    id: params.pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    boundaryLabel: "extensions directory",
    nameEncoder: params.nameEncoder,
  });
}

async function resolveEffectiveInstallMode(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  requestedMode: "install" | "update";
  targetPath: string;
}): Promise<"install" | "update"> {
  if (params.requestedMode !== "update") {
    return "install";
  }
  return (await params.runtime.fileExists(params.targetPath)) ? "update" : "install";
}

async function installBundleFromSourceDir(
  params: {
    sourceDir: string;
  } & InternalPackageInstallCommonParams,
): Promise<InstallPluginResult | null> {
  const runtime = await loadPluginInstallRuntime();
  const bundleFormat = runtime.detectBundleManifestFormat(params.sourceDir);
  if (!bundleFormat) {
    return null;
  }

  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const manifestRes = runtime.loadBundleManifest({
    rootDir: params.sourceDir,
    bundleFormat,
    rejectHardlinks: true,
  });
  if (!manifestRes.ok) {
    return { ok: false, error: manifestRes.error };
  }

  const pluginId = manifestRes.manifest.id;
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  if (params.expectedPluginId && params.expectedPluginId !== pluginId) {
    return {
      ok: false,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
      code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH,
    };
  }
  const packageManifestResult = await readOptionalPackageManifest({
    runtime,
    packageDir: params.sourceDir,
  });
  if (!packageManifestResult.ok) {
    return packageManifestResult;
  }
  const packageMetadata = packageManifestResult.manifest
    ? runtime.getPackageManifestMetadata(packageManifestResult.manifest)
    : undefined;
  const compatibilityError = validateOpenClawPackageInstallCompatibility({
    runtime,
    pluginId,
    packageMetadata,
  });
  if (compatibilityError) {
    return compatibilityError;
  }

  const targetResult = await resolvePreparedDirectoryInstallTarget({
    runtime,
    pluginId,
    extensionsDir: params.extensionsDir,
    requestedMode: mode,
  });
  if (!targetResult.ok) {
    return { ok: false, error: targetResult.error };
  }
  params.onEffectiveMode?.(targetResult.target.effectiveMode);

  const scanResult = await runInstallSourceScan({
    subject: `Bundle "${pluginId}"`,
    pluginId,
    mode: targetResult.target.effectiveMode,
    sourceFamily: sourceFamilyForInstallPolicyKind(params.installPolicyRequest?.kind, "archive"),
    scan: async () =>
      await runtime.scanBundleInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        config: params.config,
        sourceDir: params.sourceDir,
        pluginId,
        logger,
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
        source: params.installPolicyRequest?.source,
        mode: targetResult.target.effectiveMode,
        version: manifestRes.manifest.version,
      }),
  });
  if (scanResult) {
    return scanResult;
  }

  return await installPluginDirectoryIntoExtensions({
    sourceDir: params.sourceDir,
    pluginId,
    manifestName: manifestRes.manifest.name,
    version: manifestRes.manifest.version,
    extensions: [],
    targetDir: targetResult.target.targetPath,
    extensionsDir: params.extensionsDir,
    logger,
    timeoutMs,
    mode: targetResult.target.effectiveMode,
    dryRun,
    copyErrorPrefix: "failed to copy plugin bundle",
    hasDeps: false,
    depsLogMessage: "",
  });
}

async function installPluginFromSourceDir(
  params: {
    sourceDir: string;
  } & InternalPackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const nativePackageDetected = await detectNativePackageInstallSource(params.sourceDir);
  if (nativePackageDetected) {
    return await installPluginFromPackageDir({
      packageDir: params.sourceDir,
      ...pickPackageInstallCommonParams(params),
    });
  }
  const bundleResult = await installBundleFromSourceDir({
    sourceDir: params.sourceDir,
    ...pickPackageInstallCommonParams(params),
  });
  if (bundleResult) {
    return bundleResult;
  }
  return await installPluginFromPackageDir({
    packageDir: params.sourceDir,
    ...pickPackageInstallCommonParams(params),
  });
}

async function detectNativePackageInstallSource(packageDir: string): Promise<boolean> {
  const runtime = await loadPluginInstallRuntime();
  const manifestPath = path.join(packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return false;
  }

  try {
    const manifest = await runtime.readJsonFile<PackageManifest>(manifestPath);
    return ensureOpenClawExtensions({ manifest }).ok;
  } catch {
    return false;
  }
}

type ValidatedPackagePlugin = {
  manifest: PackageManifest;
  pluginId: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
  hasRuntimeDependencies: boolean;
  peerDependencies: Record<string, string>;
};

async function validatePackagePluginInstallSource(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  packageDir: string;
  expectedPluginId?: string;
  requirePluginManifest?: boolean;
  allowSourceTypeScriptEntries?: boolean;
  dangerouslyForceUnsafeInstall?: boolean;
  trustedSourceLinkedOfficialInstall?: boolean;
  config?: OpenClawConfig;
  installPolicyRequest?: PluginInstallPolicyRequest;
  logger: PluginInstallLogger;
  mode: "install" | "update";
  resolveEffectiveMode?: (pluginId: string) => Promise<"install" | "update">;
}): Promise<
  | {
      ok: true;
      plugin: ValidatedPackagePlugin;
    }
  | PluginInstallFailureResult
> {
  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await params.runtime.fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await params.runtime.readJsonFile<PackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  const pkgName = normalizeOptionalString(manifest.name) ?? "";
  const npmPluginId = pkgName || "plugin";
  const ocManifestResult = params.runtime.loadPluginManifest(params.packageDir);
  if (!ocManifestResult.ok && params.requirePluginManifest) {
    return {
      ok: false,
      error: `package missing valid openclaw.plugin.json: ${ocManifestResult.error}`,
      code: PLUGIN_INSTALL_ERROR_CODE.MISSING_PLUGIN_MANIFEST,
    };
  }
  const manifestPluginId =
    ocManifestResult.ok && ocManifestResult.manifest.id
      ? ocManifestResult.manifest.id.trim()
      : undefined;

  const pluginId = manifestPluginId ?? npmPluginId;
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  if (
    !matchesExpectedPluginId({
      expectedPluginId: params.expectedPluginId,
      pluginId,
      manifestPluginId,
      npmPluginId,
    })
  ) {
    return {
      ok: false,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
      code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH,
    };
  }

  if (manifestPluginId && !packageNameMatchesId(npmPluginId, manifestPluginId)) {
    params.logger.info?.(
      `Plugin manifest id "${manifestPluginId}" differs from npm package name "${npmPluginId}"; using manifest id as the config key.`,
    );
  }

  const packageMetadata = params.runtime.getPackageManifestMetadata(manifest);
  const compatibilityError = validateOpenClawPackageInstallCompatibility({
    runtime: params.runtime,
    pluginId,
    packageMetadata,
  });
  if (compatibilityError) {
    return compatibilityError;
  }

  const extensionsResult = ensureOpenClawExtensions({
    manifest,
  });
  if (!extensionsResult.ok) {
    return {
      ok: false,
      error: extensionsResult.error,
      code: extensionsResult.code,
    };
  }
  const extensions = extensionsResult.entries;

  const extensionValidation = await validatePackageExtensionEntriesForInstall({
    packageDir: params.packageDir,
    extensions,
    manifest,
    allowSourceTypeScriptEntries: params.allowSourceTypeScriptEntries,
  });
  if (!extensionValidation.ok) {
    return {
      ok: false,
      error: extensionValidation.error,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_OPENCLAW_EXTENSIONS,
    };
  }

  const scanMode = params.resolveEffectiveMode
    ? await params.resolveEffectiveMode(pluginId)
    : params.mode;
  const scanResult = await runInstallSourceScan({
    subject: `Plugin "${pluginId}"`,
    pluginId,
    mode: scanMode,
    sourceFamily: sourceFamilyForInstallPolicySource(
      params.installPolicyRequest?.source,
      sourceFamilyForInstallPolicyKind(params.installPolicyRequest?.kind, "installed-package"),
    ),
    scan: async () =>
      await params.runtime.scanPackageInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
        packageDir: params.packageDir,
        config: params.config,
        pluginId,
        logger: params.logger,
        extensions,
        ...(packageMetadata ? { packageMetadata } : {}),
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
        source: params.installPolicyRequest?.source,
        mode: scanMode,
        packageName: pkgName || undefined,
        manifestId: manifestPluginId,
        version: typeof manifest.version === "string" ? manifest.version : undefined,
      }),
  });
  if (scanResult) {
    return scanResult;
  }

  return {
    ok: true,
    plugin: {
      manifest,
      pluginId,
      manifestName: pkgName || undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      extensions,
      hasRuntimeDependencies: hasPackageRuntimeDependencies(manifest),
      peerDependencies: manifest.peerDependencies ?? {},
    },
  };
}

async function scanAndLinkInstalledPackage(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  installedDir: string;
  additionalDependencyPackageDirs?: string[];
  dependencyScanRootDir?: string;
  pluginId: string;
  peerDependencies: Record<string, string>;
  dangerouslyForceUnsafeInstall?: boolean;
  trustedSourceLinkedOfficialInstall?: boolean;
  mode?: "install" | "update";
  requestKind?: PluginInstallPolicyRequest["kind"];
  requestedSpecifier?: string;
  config?: OpenClawConfig;
  source?: InstallPolicySource;
  logger: PluginInstallLogger;
}): Promise<Extract<InstallPluginResult, { ok: false }> | null> {
  const scanResult = await runInstallSourceScan({
    subject: `Plugin "${params.pluginId}"`,
    pluginId: params.pluginId,
    mode: params.mode,
    sourceFamily: sourceFamilyForInstallPolicySource(
      params.source,
      sourceFamilyForInstallPolicyKind(params.requestKind, "installed-package"),
    ),
    scan: async () =>
      await params.runtime.scanInstalledPackageDependencyTree({
        ...(params.additionalDependencyPackageDirs
          ? { additionalPackageDirs: params.additionalDependencyPackageDirs }
          : {}),
        allowManagedNpmRootPackagePeerSymlinks:
          params.dependencyScanRootDir !== undefined &&
          path.resolve(params.dependencyScanRootDir) !== path.resolve(params.installedDir),
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        dependencyScanRootDir: params.dependencyScanRootDir,
        logger: params.logger,
        mode: params.mode,
        packageDir: params.installedDir,
        pluginId: params.pluginId,
        config: params.config,
        ...(params.requestKind ? { requestKind: params.requestKind } : {}),
        requestedSpecifier: params.requestedSpecifier,
        source: params.source,
        trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
      }),
  });
  if (scanResult) {
    return scanResult;
  }
  const peerLinkRepair = await linkOpenClawPeerDependencies({
    installedDir: params.installedDir,
    peerDependencies: params.peerDependencies,
    logger: params.logger,
  });
  if (peerLinkRepair.skipped > 0) {
    return {
      ok: false,
      error: formatUnresolvedOpenClawPeerLinkError(params.pluginId),
    };
  }
  return null;
}

export async function installPluginFromInstalledPackageDir(
  params: {
    additionalDependencyPackageDirs?: string[];
    emitSuccessSecurityEvent?: boolean;
    packageDir: string;
    dependencyScanRootDir?: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  return await installPluginFromInstalledPackageDirInternal(params);
}

async function installPluginFromInstalledPackageDirInternal(
  params: {
    additionalDependencyPackageDirs?: string[];
    emitSuccessSecurityEvent?: boolean;
    packageDir: string;
    dependencyScanRootDir?: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger } = runtime.resolveTimedInstallModeOptions(params, defaultLogger);
  const validated = await validatePackagePluginInstallSource({
    runtime,
    packageDir: params.packageDir,
    expectedPluginId: params.expectedPluginId,
    requirePluginManifest: params.requirePluginManifest,
    allowSourceTypeScriptEntries: params.allowSourceTypeScriptEntries,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    config: params.config,
    installPolicyRequest: params.installPolicyRequest,
    logger,
    mode: params.mode ?? "install",
  });
  if (!validated.ok) {
    return validated;
  }
  const postInstallError = await scanAndLinkInstalledPackage({
    runtime,
    installedDir: params.packageDir,
    ...(params.additionalDependencyPackageDirs
      ? { additionalDependencyPackageDirs: params.additionalDependencyPackageDirs }
      : {}),
    dependencyScanRootDir: params.dependencyScanRootDir,
    pluginId: validated.plugin.pluginId,
    peerDependencies: validated.plugin.peerDependencies,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    config: params.config,
    mode: params.mode ?? "install",
    ...(params.installPolicyRequest?.kind ? { requestKind: params.installPolicyRequest.kind } : {}),
    requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
    source: params.installPolicyRequest?.source,
    logger,
  });
  if (postInstallError) {
    return postInstallError;
  }
  const result = buildDirectoryInstallResult({
    pluginId: validated.plugin.pluginId,
    targetDir: params.packageDir,
    manifestName: validated.plugin.manifestName,
    version: validated.plugin.version,
    extensions: validated.plugin.extensions,
  });
  if (params.emitSuccessSecurityEvent !== false) {
    emitSuccessfulPluginInstallSecurityEvent(result, {
      dryRun: params.dryRun,
      mode: params.mode ?? "install",
      sourceFamily: sourceFamilyForInstallPolicyKind(
        params.installPolicyRequest?.kind,
        "installed-package",
      ),
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    });
  }
  return result;
}

async function installPluginFromPackageDir(
  params: {
    packageDir: string;
  } & InternalPackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  let preparedTarget: PreparedInstallTarget | undefined;
  const resolvePreparedTargetForPluginId = async (pluginId: string) => {
    if (!preparedTarget) {
      const targetResult = await resolvePreparedDirectoryInstallTarget({
        runtime,
        pluginId,
        extensionsDir: params.extensionsDir,
        requestedMode: mode,
        nameEncoder: encodePluginInstallDirName,
      });
      if (!targetResult.ok) {
        throw new Error(targetResult.error);
      }
      preparedTarget = targetResult.target;
    }
    return preparedTarget;
  };

  const validated = await validatePackagePluginInstallSource({
    runtime,
    packageDir: params.packageDir,
    expectedPluginId: params.expectedPluginId,
    requirePluginManifest: params.requirePluginManifest,
    allowSourceTypeScriptEntries: params.allowSourceTypeScriptEntries,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    config: params.config,
    installPolicyRequest: params.installPolicyRequest,
    logger,
    mode,
    resolveEffectiveMode: async (pluginId) =>
      (await resolvePreparedTargetForPluginId(pluginId)).effectiveMode,
  });
  if (!validated.ok) {
    return validated;
  }
  const { plugin } = validated;

  preparedTarget = await resolvePreparedTargetForPluginId(plugin.pluginId);
  const effectiveMode = preparedTarget.effectiveMode;
  params.onEffectiveMode?.(effectiveMode);
  const hasBundleManifest = Boolean(runtime.detectBundleManifestFormat(params.packageDir));
  const shouldInstallRuntimeDeps =
    plugin.hasRuntimeDependencies &&
    !hasBundleManifest &&
    params.installPolicyRequest?.kind === "plugin-archive";

  return await installPluginDirectoryIntoExtensions({
    sourceDir: params.packageDir,
    pluginId: plugin.pluginId,
    manifestName: plugin.manifestName,
    version: plugin.version,
    extensions: plugin.extensions,
    targetDir: preparedTarget.targetPath,
    extensionsDir: params.extensionsDir,
    logger,
    timeoutMs,
    mode: effectiveMode,
    dryRun,
    copyErrorPrefix: "failed to copy plugin",
    hasDeps: shouldInstallRuntimeDeps,
    sourceHardlinks: shouldInstallRuntimeDeps ? "package-manager" : "reject",
    depsLogMessage: "Installing plugin dependencies…",
    nameEncoder: encodePluginInstallDirName,
    afterInstall: async (installedDir) => {
      return await scanAndLinkInstalledPackage({
        runtime,
        installedDir,
        pluginId: plugin.pluginId,
        peerDependencies: plugin.peerDependencies,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
        config: params.config,
        mode: effectiveMode,
        ...(params.installPolicyRequest?.kind
          ? { requestKind: params.installPolicyRequest.kind }
          : {}),
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
        source: params.installPolicyRequest?.source,
        logger,
      });
    },
  });
}

export async function installPluginFromArchive(
  params: {
    archivePath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-archive",
    requestedSpecifier: params.archivePath,
    source: localPluginInstallPolicySource("plugin-archive"),
  };
  const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;
  let effectiveMode = mode;

  const result = await runtime.withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-plugin-",
    timeoutMs,
    logger,
    rootMarkers: PLUGIN_ARCHIVE_ROOT_MARKERS,
    onExtracted: async (sourceDir) =>
      await installPluginFromSourceDir({
        sourceDir,
        ...pickPackageInstallCommonParams({
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          extensionsDir: params.extensionsDir,
          timeoutMs,
          logger,
          mode,
          dryRun: params.dryRun,
          config: params.config,
          expectedPluginId: params.expectedPluginId,
          trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
          requirePluginManifest: true,
          installPolicyRequest,
          onEffectiveMode: (resolvedMode) => {
            effectiveMode = resolvedMode;
          },
        }),
      }),
  });
  emitSuccessfulPluginInstallSecurityEvent(result, {
    dryRun: params.dryRun,
    mode: effectiveMode,
    sourceFamily: "archive",
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
  return result;
}

async function installPluginFromDir(
  params: {
    dirPath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const dirPath = resolveUserPath(params.dirPath);
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-dir",
    requestedSpecifier: params.dirPath,
    source: localPluginInstallPolicySource("plugin-dir"),
  };
  if (!(await runtime.fileExists(dirPath))) {
    return { ok: false, error: `directory not found: ${dirPath}` };
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${dirPath}` };
  }

  let effectiveMode = params.mode ?? "install";
  const result = await installPluginFromSourceDir({
    sourceDir: dirPath,
    ...pickPackageInstallCommonParams({
      ...params,
      installPolicyRequest,
      onEffectiveMode: (resolvedMode) => {
        effectiveMode = resolvedMode;
      },
    }),
  });
  emitSuccessfulPluginInstallSecurityEvent(result, {
    dryRun: params.dryRun,
    mode: effectiveMode,
    sourceFamily: sourceFamilyForInstallPolicyKind(installPolicyRequest.kind, "directory"),
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
  return result;
}

export async function installPluginFromNpmSpec(
  params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
  },
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedPluginId = params.expectedPluginId;
  const spec = params.spec.trim();
  const specError = runtime.validateRegistryNpmSpec(spec);
  if (specError) {
    return {
      ok: false,
      error: specError,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }

  const parsedSpec = parseRegistryNpmSpec(spec);
  if (!parsedSpec) {
    return {
      ok: false,
      error: "unsupported npm spec",
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }

  const metadataResult = await resolveNpmSpecMetadata({ spec, timeoutMs });
  if (!metadataResult.ok) {
    return {
      ok: false,
      error: metadataResult.error,
      ...(isNpmPackageNotFoundMessage(metadataResult.error)
        ? { code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND }
        : {}),
    };
  }
  const npmResolution: NpmSpecResolution = {
    ...metadataResult.metadata,
    resolvedAt: new Date().toISOString(),
  };
  if (
    npmResolution.version &&
    !isPrereleaseResolutionAllowed({
      spec: parsedSpec,
      resolvedVersion: npmResolution.version,
    })
  ) {
    const trustedResolution = params.trustedSourceLinkedOfficialInstall
      ? await resolveTrustedOfficialPrereleaseResolution({
          spec: parsedSpec,
          resolvedPrereleaseVersion: npmResolution.version,
          timeoutMs,
          logger,
        })
      : null;
    if (trustedResolution?.kind === "stable" || trustedResolution?.kind === "prerelease-only") {
      Object.assign(npmResolution, trustedResolution.resolution, {
        resolvedAt: npmResolution.resolvedAt,
      });
    } else if (trustedResolution?.kind === "allow-prerelease-only") {
      // Keep the original prerelease resolution. The package has no stable line yet.
    } else {
      return {
        ok: false,
        error: formatPrereleaseResolutionError({
          spec: parsedSpec,
          resolvedVersion: npmResolution.version,
        }),
      };
    }
  }
  let compatibilityError = validateNpmResolutionCompatibility({
    runtime,
    parsedSpec,
    expectedPluginId,
    resolution: npmResolution,
  });
  if (compatibilityError && canResolveAroundCompatibilityError(compatibilityError)) {
    const compatibleResolution = await resolveLatestCompatibleNpmResolution({
      runtime,
      parsedSpec,
      expectedPluginId,
      currentResolution: npmResolution,
      timeoutMs,
      logger,
    });
    if (compatibleResolution) {
      Object.assign(npmResolution, compatibleResolution, {
        resolvedAt: npmResolution.resolvedAt,
      });
      compatibilityError = validateNpmResolutionCompatibility({
        runtime,
        parsedSpec,
        expectedPluginId,
        resolution: npmResolution,
      });
    }
  }
  if (compatibilityError) {
    return compatibilityError;
  }
  const npmInstallPolicySource = {
    kind: "npm",
    authority: params.trustedSourceLinkedOfficialInstall ? "official" : "third-party",
    mutable: false,
    network: true,
  } as const;
  const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
    spec,
    expectedIntegrity: params.expectedIntegrity,
    resolution: npmResolution,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => logger.warn?.(message),
  });
  if (driftResult.error) {
    return { ok: false, error: driftResult.error };
  }
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const generationUse = await resolveManagedNpmGenerationUseForInstall({
    runtime,
    npmBaseDir,
    packageName: parsedSpec.name,
    requestedMode: mode,
    npmResolution,
  });
  const npmRoot = resolveManagedNpmRootForInstall({
    npmBaseDir,
    packageName: parsedSpec.name,
    npmResolution,
    useGeneration: generationUse !== "none",
  });
  const installRoot = resolveManagedNpmRootPackageDir(npmRoot, parsedSpec.name);
  const targetMode =
    generationUse === "retained-install" && hasRetainedManagedNpmInstallMarker(installRoot)
      ? "update"
      : await resolveEffectiveInstallMode({
          runtime,
          requestedMode: mode,
          targetPath: installRoot,
        });
  const policyMode =
    generationUse === "update"
      ? "update"
      : generationUse === "retained-install"
        ? "install"
        : targetMode;

  const policyTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-policy-"));
  try {
    const policyMetadataPath = path.join(policyTempDir, "npm-package-metadata.json");
    await fs.writeFile(
      policyMetadataPath,
      `${JSON.stringify(
        {
          packageName: parsedSpec.name,
          requestedSpecifier: spec,
          resolution: npmResolution,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const preflightPolicyResult = await runInstallSourceScan({
      subject: `Plugin "${expectedPluginId ?? parsedSpec.name}"`,
      pluginId: expectedPluginId ?? parsedSpec.name,
      mode: policyMode,
      sourceFamily: "npm",
      scan: async () =>
        await preflightPluginNpmInstallPolicy({
          config: params.config,
          logger,
          mode: policyMode,
          packageName: parsedSpec.name,
          ...(expectedPluginId ? { pluginId: expectedPluginId } : {}),
          requestedSpecifier: spec,
          source: npmInstallPolicySource,
          sourcePath: policyMetadataPath,
          sourcePathKind: "file",
        }),
    });
    if (preflightPolicyResult) {
      return preflightPolicyResult;
    }
  } finally {
    await fs.rm(policyTempDir, { recursive: true, force: true });
  }

  const result = await installPluginFromManagedNpmRoot({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    config: params.config,
    packageName: parsedSpec.name,
    dependencySpec: resolveManagedNpmRootDependencySpec({
      parsedSpec,
      resolution: npmResolution,
    }),
    displaySpec: spec,
    installPolicyRequest: {
      kind: "plugin-npm",
      requestedSpecifier: spec,
      source: npmInstallPolicySource,
    },
    extensionsDir: params.extensionsDir,
    npmDir: params.npmDir,
    timeoutMs,
    logger,
    mode,
    dryRun,
    skipPolicyPreflight: true,
    expectedPluginId,
    npmResolution,
    ...(driftResult.integrityDrift ? { integrityDrift: driftResult.integrityDrift } : {}),
  });
  emitSuccessfulPluginInstallSecurityEvent(result, {
    dryRun,
    mode: policyMode,
    sourceFamily: "npm",
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
  return result;
}

export async function installPluginFromNpmPackArchive(
  params: InstallSafetyOverrides & {
    archivePath: string;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
  },
): Promise<InstallPluginResult & { npmTarballName?: string }> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const metadataResult = await resolveNpmPackArchiveMetadata({
    archivePath: params.archivePath,
    timeoutMs,
  });
  if (!metadataResult.ok) {
    return metadataResult;
  }
  const npmResolution: NpmSpecResolution = {
    ...metadataResult.metadata,
    resolvedAt: new Date().toISOString(),
  };
  const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
    spec: metadataResult.archivePath,
    expectedIntegrity: params.expectedIntegrity,
    resolution: npmResolution,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => logger.warn?.(message),
  });
  if (driftResult.error) {
    return { ok: false, error: driftResult.error };
  }
  const packageNameResult = resolveTrustedNpmPackPackageName(metadataResult.metadata.name);
  if (!packageNameResult.ok) {
    return packageNameResult;
  }
  const packageName = packageNameResult.packageName;
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const generationUse = await resolveManagedNpmGenerationUseForInstall({
    runtime,
    npmBaseDir,
    packageName,
    requestedMode: mode,
    npmResolution,
  });
  const npmProjectRoot = resolveManagedNpmRootForInstall({
    npmBaseDir,
    packageName,
    npmResolution,
    useGeneration: generationUse !== "none",
  });
  const installRoot = resolveManagedNpmRootPackageDir(npmProjectRoot, packageName);
  const targetMode =
    generationUse === "retained-install" && hasRetainedManagedNpmInstallMarker(installRoot)
      ? "update"
      : await resolveEffectiveInstallMode({
          runtime,
          requestedMode: mode,
          targetPath: installRoot,
        });
  const policyMode =
    generationUse === "update"
      ? "update"
      : generationUse === "retained-install"
        ? "install"
        : targetMode;

  const result = await installPluginFromManagedNpmRoot({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    config: params.config,
    packageName,
    prepareDependencySpec: async ({ npmRoot }) => {
      try {
        return {
          ok: true,
          ...(await stageNpmPackArchiveInManagedRoot({
            archivePath: metadataResult.archivePath,
            npmRoot,
            packageName,
            version: metadataResult.metadata.version,
            integrity: metadataResult.metadata.integrity,
            shasum: metadataResult.metadata.shasum,
            tarballName: metadataResult.tarballName,
          })),
        };
      } catch (error) {
        return {
          ok: false,
          error: `Failed to stage npm pack archive in managed npm root: ${String(error)}`,
        };
      }
    },
    displaySpec: metadataResult.archivePath,
    installPolicyRequest: {
      kind: "plugin-npm",
      requestedSpecifier: `npm-pack:${metadataResult.archivePath}`,
      source: { kind: "archive", authority: "user", mutable: true, network: false },
    },
    policyPreflightSourcePath: metadataResult.archivePath,
    policyPreflightSourcePathKind: "file",
    extensionsDir: params.extensionsDir,
    npmDir: npmBaseDir,
    timeoutMs,
    logger,
    mode,
    dryRun,
    expectedPluginId: params.expectedPluginId,
    npmResolution,
    ...(driftResult.integrityDrift ? { integrityDrift: driftResult.integrityDrift } : {}),
  });
  emitSuccessfulPluginInstallSecurityEvent(result, {
    dryRun,
    mode: policyMode,
    sourceFamily: "archive",
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
  return {
    ...result,
    ...(result.ok ? { npmTarballName: metadataResult.tarballName } : {}),
  };
}

export async function installPluginFromPath(
  params: {
    path: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const pathResult = await runtime.resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;
  const packageInstallOptions = pickPackageInstallCommonParams(params);

  if (stat.isDirectory()) {
    return await installPluginFromDir({
      dirPath: resolved,
      ...packageInstallOptions,
      installPolicyRequest: installPolicyRequestForPath(params, "plugin-dir"),
    });
  }

  const archiveKind = runtime.resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      archivePath: resolved,
      ...packageInstallOptions,
      installPolicyRequest: installPolicyRequestForPath(params, "plugin-archive"),
    });
  }

  return {
    ok: false,
    code: PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN,
    error:
      "Plain file plugin installs are not supported. Install a plugin directory or archive that contains openclaw.plugin.json, or list standalone plugin files in plugins.load.paths.",
  };
}
