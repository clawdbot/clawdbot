import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { packageNameMatchesId } from "../infra/install-safe-path.js";
import {
  resolveNpmPackArchiveMetadata,
  resolveNpmSpecMetadata,
  type NpmIntegrityDrift,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import {
  readManagedNpmRootInstalledDependency,
  readOpenClawManagedNpmRootOverrides,
  repairManagedNpmRootOpenClawPeer,
  removeManagedNpmRootDependency,
  resolveManagedNpmRootDependencySpec,
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
import { compareComparableSemver, parseComparableSemver } from "../infra/semver-compare.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import {
  encodePluginInstallDirName,
  matchesExpectedPluginId,
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
  safePluginInstallFileName,
  validatePluginId,
} from "./install-paths.js";
import type { InstallSecurityScanResult } from "./install-security-scan.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import {
  resolvePackageExtensionEntries,
  type PackageManifest as PluginPackageManifest,
} from "./manifest.js";
import { validatePackageExtensionEntriesForInstall } from "./package-entry-resolution.js";
import {
  linkOpenClawPeerDependencies,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";

export { resolvePluginInstallDir } from "./install-paths.js";

const pluginInstallRuntimeLoader = createLazyImportLoader(() => import("./install.runtime.js"));

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

function formatUnresolvedOpenClawPeerLinkError(packageName: string): string {
  return `Installed plugin ${packageName} declares openclaw as a peer dependency, but OpenClaw could not create a plugin-local node_modules/openclaw link. Run from a packaged OpenClaw install or reinstall OpenClaw, then retry.`;
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

export const PLUGIN_INSTALL_ERROR_CODE = {
  INVALID_NPM_SPEC: "invalid_npm_spec",
  INVALID_MIN_HOST_VERSION: "invalid_min_host_version",
  UNKNOWN_HOST_VERSION: "unknown_host_version",
  INCOMPATIBLE_HOST_VERSION: "incompatible_host_version",
  MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions",
  MISSING_PLUGIN_MANIFEST: "missing_plugin_manifest",
  EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions",
  INVALID_OPENCLAW_EXTENSIONS: "invalid_openclaw_extensions",
  NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  SECURITY_SCAN_BLOCKED: "security_scan_blocked",
  SECURITY_SCAN_FAILED: "security_scan_failed",
} as const;

export type PluginInstallErrorCode =
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

export type PluginNpmIntegrityDriftParams = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

type PluginInstallPolicyRequest = {
  kind: "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm" | "plugin-git";
  requestedSpecifier?: string;
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
  return compareComparableSemver(parseComparableSemver(a), parseComparableSemver(b)) ?? 0;
}

type TrustedOfficialPrereleaseResolution =
  | { kind: "stable"; resolution: NpmSpecResolution }
  | { kind: "prerelease-only"; resolution: NpmSpecResolution }
  | { kind: "allow-prerelease-only" };

async function resolveTrustedOfficialPrereleaseResolution(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedPrereleaseVersion: string;
  timeoutMs: number;
  logger: PluginInstallLogger;
}): Promise<TrustedOfficialPrereleaseResolution | null> {
  if (!params.spec.name.startsWith("@openclaw/")) {
    return null;
  }
  const versions = await runCommandWithTimeout(
    ["npm", "view", params.spec.name, "versions", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs, 60_000),
      env: {
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
      },
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
  const semverVersions = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is string => typeof value === "string" && isExactSemverVersion(value),
  );
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

function buildFileInstallResult(pluginId: string, targetFile: string): InstallPluginResult {
  return {
    ok: true,
    pluginId,
    targetDir: targetFile,
    manifestName: undefined,
    version: undefined,
    extensions: [path.basename(targetFile)],
  };
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
}): Promise<void> {
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
    dependencySpec: string;
    displaySpec: string;
    installPolicyRequest: PluginInstallPolicyRequest;
    npmResolution: NpmSpecResolution;
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
  const npmRoot = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const installRoot = path.join(npmRoot, "node_modules", params.packageName);
  const effectiveMode = await resolveEffectiveInstallMode({
    runtime,
    requestedMode: mode,
    targetPath: installRoot,
  });
  const availability = await ensureInstallTargetAvailableForMode({
    runtime,
    targetPath: installRoot,
    mode: effectiveMode,
  });
  if (!availability.ok) {
    return availability;
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
  await upsertManagedNpmRootDependency({
    npmRoot,
    packageName: params.packageName,
    dependencySpec: params.dependencySpec,
    managedOverrides: await readOpenClawManagedNpmRootOverrides(),
  });
  const install = await runCommandWithTimeout(
    [
      "npm",
      ...createSafeNpmInstallArgs({
        omitDev: true,
        omitPeer: true,
        loglevel: "error",
        legacyPeerDeps: true,
        noAudit: true,
        noFund: true,
      }),
    ],
    {
      cwd: npmRoot,
      timeoutMs: Math.max(timeoutMs, 300_000),
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: true,
        packageLock: true,
        quiet: true,
      }),
    },
  );
  if (install.code !== 0) {
    await rollbackManagedNpmPluginInstall({
      npmRoot,
      packageName: params.packageName,
      targetDir: installRoot,
      timeoutMs,
      logger,
    });
    return {
      ok: false,
      error: `npm install failed: ${install.stderr.trim() || install.stdout.trim()}`,
    };
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
    await relinkOpenClawPeerDependenciesInManagedNpmRoot({ npmRoot, logger });
  } catch (error) {
    await rollbackManagedNpmPluginInstall({
      npmRoot,
      packageName: params.packageName,
      targetDir: installRoot,
      timeoutMs,
      logger,
    });
    return {
      ok: false,
      error: `Failed to repair openclaw peer links after npm install: ${String(error)}`,
    };
  }
  if (installedPackageNeedsOpenClawPeerLinkRepair(installRoot)) {
    await rollbackManagedNpmPluginInstall({
      npmRoot,
      packageName: params.packageName,
      targetDir: installRoot,
      timeoutMs,
      logger,
    });
    return {
      ok: false,
      error: formatUnresolvedOpenClawPeerLinkError(params.packageName),
    };
  }

  let installedDependency: ManagedNpmRootInstalledDependency | null;
  try {
    installedDependency = await readManagedNpmRootInstalledDependency({
      npmRoot,
      packageName: params.packageName,
    });
  } catch (error) {
    await rollbackManagedNpmPluginInstall({
      npmRoot,
      packageName: params.packageName,
      targetDir: installRoot,
      timeoutMs,
      logger,
    });
    return {
      ok: false,
      error: `Failed to verify npm install metadata for ${params.packageName}: ${String(error)}`,
    };
  }
  const resolutionMismatch = resolveInstalledNpmResolutionMismatch({
    packageName: params.packageName,
    expected: params.npmResolution,
    installed: installedDependency,
  });
  if (resolutionMismatch) {
    await rollbackManagedNpmPluginInstall({
      npmRoot,
      packageName: params.packageName,
      targetDir: installRoot,
      timeoutMs,
      logger,
    });
    return {
      ok: false,
      error: resolutionMismatch,
    };
  }

  const result = await installPluginFromInstalledPackageDir({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    packageDir: installRoot,
    dependencyScanRootDir: npmRoot,
    logger,
    expectedPluginId,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    mode: effectiveMode,
    installPolicyRequest: params.installPolicyRequest,
  });
  if (!result.ok) {
    await rollbackManagedNpmPluginInstall({
      npmRoot,
      packageName: params.packageName,
      targetDir: installRoot,
      timeoutMs,
      logger,
    });
    return result;
  }
  return {
    ...result,
    npmResolution: params.npmResolution,
    ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
  };
}

async function stageNpmPackArchiveInManagedRoot(params: {
  archivePath: string;
  npmRoot: string;
  packageName: string;
  version?: string;
  integrity?: string;
  shasum?: string;
  tarballName: string;
}): Promise<{ stableArchivePath: string; dependencySpec: string }> {
  const archiveStoreDir = path.join(params.npmRoot, MANAGED_NPM_PACK_ARCHIVE_DIR);
  const identity = params.integrity ?? params.shasum ?? params.tarballName;
  const identitySlug = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const packageSlug = safePluginInstallFileName(params.packageName) || "plugin";
  const versionSlug = safePluginInstallFileName(params.version ?? "pack") || "pack";
  const archiveFileName = `${packageSlug}-${versionSlug}-${identitySlug}.tgz`;
  const stableArchivePath = path.join(archiveStoreDir, archiveFileName);

  await fs.mkdir(archiveStoreDir, { recursive: true });
  await fs.copyFile(params.archivePath, stableArchivePath);

  return {
    stableArchivePath,
    dependencySpec: `file:./${path.posix.join(MANAGED_NPM_PACK_ARCHIVE_DIR, archiveFileName)}`,
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
  installPolicyRequest?: PluginInstallPolicyRequest;
};

type FileInstallCommonParams = Pick<
  PackageInstallCommonParams,
  | "dangerouslyForceUnsafeInstall"
  | "trustedSourceLinkedOfficialInstall"
  | "extensionsDir"
  | "logger"
  | "mode"
  | "dryRun"
  | "installPolicyRequest"
>;

function pickPackageInstallCommonParams(
  params: PackageInstallCommonParams,
): PackageInstallCommonParams {
  return {
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
    installPolicyRequest: params.installPolicyRequest,
  };
}

function pickFileInstallCommonParams(params: FileInstallCommonParams): FileInstallCommonParams {
  return {
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    extensionsDir: params.extensionsDir,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    installPolicyRequest: params.installPolicyRequest,
  };
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
  scan: () => Promise<InstallSecurityScanResult | undefined>;
}): Promise<Extract<InstallPluginResult, { ok: false }> | null> {
  try {
    const scanResult = await params.scan();
    if (scanResult?.blocked) {
      return buildBlockedInstallResult({ blocked: scanResult.blocked });
    }
    return null;
  } catch (err) {
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
  } & PackageInstallCommonParams,
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

  const targetResult = await resolvePreparedDirectoryInstallTarget({
    runtime,
    pluginId,
    extensionsDir: params.extensionsDir,
    requestedMode: mode,
  });
  if (!targetResult.ok) {
    return { ok: false, error: targetResult.error };
  }

  const scanResult = await runInstallSourceScan({
    subject: `Bundle "${pluginId}"`,
    scan: async () =>
      await runtime.scanBundleInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        sourceDir: params.sourceDir,
        pluginId,
        logger,
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
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
  } & PackageInstallCommonParams,
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
  dangerouslyForceUnsafeInstall?: boolean;
  trustedSourceLinkedOfficialInstall?: boolean;
  installPolicyRequest?: PluginInstallPolicyRequest;
  logger: PluginInstallLogger;
  mode: "install" | "update";
  resolveEffectiveMode?: (pluginId: string) => Promise<"install" | "update">;
}): Promise<
  | {
      ok: true;
      plugin: ValidatedPackagePlugin;
    }
  | Extract<InstallPluginResult, { ok: false }>
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
  const minHostVersionCheck = params.runtime.checkMinHostVersion({
    currentVersion: params.runtime.resolveCompatibilityHostVersion(),
    minHostVersion: packageMetadata?.install?.minHostVersion,
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
        error: `plugin "${pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.`,
        code: PLUGIN_INSTALL_ERROR_CODE.UNKNOWN_HOST_VERSION,
      };
    }
    return {
      ok: false,
      error: `plugin "${pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}. Upgrade OpenClaw and retry.`,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION,
    };
  }

  const extensionValidation = await validatePackageExtensionEntriesForInstall({
    packageDir: params.packageDir,
    extensions,
    manifest,
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
    scan: async () =>
      await params.runtime.scanPackageInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
        packageDir: params.packageDir,
        pluginId,
        logger: params.logger,
        extensions,
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
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
  dependencyScanRootDir?: string;
  pluginId: string;
  peerDependencies: Record<string, string>;
  logger: PluginInstallLogger;
}): Promise<Extract<InstallPluginResult, { ok: false }> | null> {
  const scanResult = await runInstallSourceScan({
    subject: `Plugin "${params.pluginId}"`,
    scan: async () =>
      await params.runtime.scanInstalledPackageDependencyTree({
        allowManagedNpmRootPackagePeerSymlinks:
          params.dependencyScanRootDir !== undefined &&
          path.resolve(params.dependencyScanRootDir) !== path.resolve(params.installedDir),
        logger: params.logger,
        packageDir: params.dependencyScanRootDir ?? params.installedDir,
        pluginId: params.pluginId,
      }),
  });
  if (scanResult) {
    return scanResult;
  }
  await linkOpenClawPeerDependencies({
    installedDir: params.installedDir,
    peerDependencies: params.peerDependencies,
    logger: params.logger,
  });
  return null;
}

export async function installPluginFromInstalledPackageDir(
  params: {
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
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
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
    dependencyScanRootDir: params.dependencyScanRootDir,
    pluginId: validated.plugin.pluginId,
    peerDependencies: validated.plugin.peerDependencies,
    logger,
  });
  if (postInstallError) {
    return postInstallError;
  }
  return buildDirectoryInstallResult({
    pluginId: validated.plugin.pluginId,
    targetDir: params.packageDir,
    manifestName: validated.plugin.manifestName,
    version: validated.plugin.version,
    extensions: validated.plugin.extensions,
  });
}

async function installPluginFromPackageDir(
  params: {
    packageDir: string;
  } & PackageInstallCommonParams,
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
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
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
  const hasBundleManifest = Boolean(runtime.detectBundleManifestFormat(params.packageDir));

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
    mode: preparedTarget.effectiveMode,
    dryRun,
    copyErrorPrefix: "failed to copy plugin",
    hasDeps:
      plugin.hasRuntimeDependencies &&
      !hasBundleManifest &&
      params.installPolicyRequest?.kind === "plugin-archive",
    depsLogMessage: "Installing plugin dependencies…",
    nameEncoder: encodePluginInstallDirName,
    afterInstall: async (installedDir) => {
      return await scanAndLinkInstalledPackage({
        runtime,
        installedDir,
        pluginId: plugin.pluginId,
        peerDependencies: plugin.peerDependencies,
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
  };
  const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;

  return await runtime.withExtractedArchiveRoot({
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
          expectedPluginId: params.expectedPluginId,
          trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
          requirePluginManifest: true,
          installPolicyRequest,
        }),
      }),
  });
}

export async function installPluginFromDir(
  params: {
    dirPath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const dirPath = resolveUserPath(params.dirPath);
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-dir",
    requestedSpecifier: params.dirPath,
  };
  if (!(await runtime.fileExists(dirPath))) {
    return { ok: false, error: `directory not found: ${dirPath}` };
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${dirPath}` };
  }

  return await installPluginFromSourceDir({
    sourceDir: dirPath,
    ...pickPackageInstallCommonParams({
      ...params,
      installPolicyRequest,
    }),
  });
}

export async function installPluginFromFile(params: {
  filePath: string;
  dangerouslyForceUnsafeInstall?: boolean;
  extensionsDir?: string;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  installPolicyRequest?: PluginInstallPolicyRequest;
}): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, mode, dryRun } = runtime.resolveInstallModeOptions(params, defaultLogger);

  const filePath = resolveUserPath(params.filePath);
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-file",
    requestedSpecifier: params.filePath,
  };
  if (!(await runtime.fileExists(filePath))) {
    return { ok: false, error: `file not found: ${filePath}` };
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : resolveDefaultPluginExtensionsDir();
  await fs.mkdir(extensionsDir, { recursive: true });

  const base = path.basename(filePath, path.extname(filePath));
  const pluginId = base || "plugin";
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  const targetFile = path.join(
    extensionsDir,
    `${safePluginInstallFileName(pluginId)}${path.extname(filePath)}`,
  );
  const preparedTarget: PreparedInstallTarget = {
    targetPath: targetFile,
    effectiveMode: await resolveEffectiveInstallMode({
      runtime,
      requestedMode: mode,
      targetPath: targetFile,
    }),
  };

  const availability = await ensureInstallTargetAvailableForMode({
    runtime,
    targetPath: preparedTarget.targetPath,
    mode: preparedTarget.effectiveMode,
  });
  if (!availability.ok) {
    return availability;
  }

  if (dryRun) {
    return buildFileInstallResult(pluginId, preparedTarget.targetPath);
  }

  const scanResult = await runInstallSourceScan({
    subject: `Plugin file "${pluginId}"`,
    scan: async () =>
      await runtime.scanFileInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        filePath,
        logger,
        mode: preparedTarget.effectiveMode,
        pluginId,
        requestedSpecifier: installPolicyRequest.requestedSpecifier,
      }),
  });
  if (scanResult) {
    return scanResult;
  }

  logger.info?.(`Installing to ${preparedTarget.targetPath}…`);
  try {
    const root = await runtime.root(extensionsDir);
    await root.copyIn(path.basename(preparedTarget.targetPath), filePath);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  return buildFileInstallResult(pluginId, preparedTarget.targetPath);
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

  return await installPluginFromManagedNpmRoot({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    packageName: parsedSpec.name,
    dependencySpec: resolveManagedNpmRootDependencySpec({
      parsedSpec,
      resolution: npmResolution,
    }),
    displaySpec: spec,
    installPolicyRequest: {
      kind: "plugin-npm",
      requestedSpecifier: spec,
    },
    extensionsDir: params.extensionsDir,
    npmDir: params.npmDir,
    timeoutMs,
    logger,
    mode,
    dryRun,
    expectedPluginId,
    npmResolution,
    ...(driftResult.integrityDrift ? { integrityDrift: driftResult.integrityDrift } : {}),
  });
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
  const npmRoot = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  let dependencySpec = "";
  if (!dryRun) {
    try {
      dependencySpec = (
        await stageNpmPackArchiveInManagedRoot({
          archivePath: metadataResult.archivePath,
          npmRoot,
          packageName,
          version: metadataResult.metadata.version,
          integrity: metadataResult.metadata.integrity,
          shasum: metadataResult.metadata.shasum,
          tarballName: metadataResult.tarballName,
        })
      ).dependencySpec;
    } catch (error) {
      return {
        ok: false,
        error: `Failed to stage npm pack archive in managed npm root: ${String(error)}`,
      };
    }
  }

  const result = await installPluginFromManagedNpmRoot({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    packageName,
    dependencySpec,
    displaySpec: metadataResult.archivePath,
    installPolicyRequest: {
      kind: "plugin-npm",
      requestedSpecifier: `npm-pack:${metadataResult.archivePath}`,
    },
    extensionsDir: params.extensionsDir,
    npmDir: npmRoot,
    timeoutMs,
    logger,
    mode,
    dryRun,
    expectedPluginId: params.expectedPluginId,
    npmResolution,
    ...(driftResult.integrityDrift ? { integrityDrift: driftResult.integrityDrift } : {}),
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
      installPolicyRequest: {
        kind: "plugin-dir",
        requestedSpecifier: params.path,
      },
    });
  }

  const archiveKind = runtime.resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      archivePath: resolved,
      ...packageInstallOptions,
      installPolicyRequest: {
        kind: "plugin-archive",
        requestedSpecifier: params.path,
      },
    });
  }

  return await installPluginFromFile({
    filePath: resolved,
    ...pickFileInstallCommonParams({
      ...params,
      installPolicyRequest: {
        kind: "plugin-file",
        requestedSpecifier: params.path,
      },
    }),
  });
}
