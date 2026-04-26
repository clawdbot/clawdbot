import fs from "node:fs/promises";
import path from "node:path";
import {
  packageNameMatchesId,
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
  unscopedPackageName,
} from "../infra/install-safe-path.js";
import { type NpmIntegrityDrift, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import type { InstallSecurityScanResult } from "./install-security-scan.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import {
  resolvePackageExtensionEntries,
  type PackageManifest as PluginPackageManifest,
} from "./manifest.js";

let pluginInstallRuntimePromise: Promise<typeof import("./install.runtime.js")> | undefined;

async function loadPluginInstallRuntime() {
  pluginInstallRuntimePromise ??= import("./install.runtime.js");
  return pluginInstallRuntimePromise;
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

const MISSING_EXTENSIONS_ERROR =
  'package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example ["./dist/index.js"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions';
const PLUGIN_ARCHIVE_ROOT_MARKERS = [
  "package.json",
  "openclaw.plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];

export const PLUGIN_INSTALL_ERROR_CODE = {
  INVALID_NPM_SPEC: "invalid_npm_spec",
  INVALID_MIN_HOST_VERSION: "invalid_min_host_version",
  UNKNOWN_HOST_VERSION: "unknown_host_version",
  INCOMPATIBLE_HOST_VERSION: "incompatible_host_version",
  MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions",
  MISSING_PLUGIN_MANIFEST: "missing_plugin_manifest",
  EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions",
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
  kind: "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm";
  requestedSpecifier?: string;
};

const defaultLogger: PluginInstallLogger = {};
function safeFileName(input: string): string {
  return safeDirName(input);
}

function encodePluginInstallDirName(pluginId: string): string {
  const trimmed = pluginId.trim();
  if (!trimmed.includes("/")) {
    return safeDirName(trimmed);
  }
  // Scoped plugin ids need a reserved on-disk namespace so they cannot collide
  // with valid unscoped ids that happen to match the hashed slug.
  return `@${safePathSegmentHashed(trimmed)}`;
}

function validatePluginId(pluginId: string): string | null {
  const trimmed = pluginId.trim();
  if (!trimmed) {
    return "invalid plugin name: missing";
  }
  if (trimmed.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment)) {
    return "invalid plugin name: malformed scope";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "invalid plugin name: reserved path segment";
  }
  if (segments.length === 1) {
    if (trimmed.startsWith("@")) {
      return "invalid plugin name: scoped ids must use @scope/name format";
    }
    return null;
  }
  if (segments.length !== 2) {
    return "invalid plugin name: path separators not allowed";
  }
  if (!segments[0]?.startsWith("@") || segments[0].length < 2) {
    return "invalid plugin name: scoped ids must use @scope/name format";
  }
  return null;
}

function matchesExpectedPluginId(params: {
  expectedPluginId?: string;
  pluginId: string;
  manifestPluginId?: string;
  npmPluginId: string;
}): boolean {
  if (!params.expectedPluginId) {
    return true;
  }
  if (params.expectedPluginId === params.pluginId) {
    return true;
  }
  // Backward compatibility: older install records keyed scoped npm packages by
  // their unscoped package name. Preserve update-in-place for those records
  // unless the package declares an explicit manifest id override.
  return (
    !params.manifestPluginId &&
    params.pluginId === params.npmPluginId &&
    params.expectedPluginId === unscopedPackageName(params.npmPluginId)
  );
}

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

type PackageInstallCommonParams = InstallSafetyOverrides & {
  extensionsDir?: string;
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
    extensionsDir: params.extensionsDir,
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

export function resolvePluginInstallDir(pluginId: string, extensionsDir?: string): string {
  const extensionsBase = extensionsDir
    ? resolveUserPath(extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    throw new Error(pluginIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: extensionsBase,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    nameEncoder: encodePluginInstallDirName,
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

async function resolvePluginInstallTarget(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  pluginId: string;
  extensionsDir?: string;
  nameEncoder?: (pluginId: string) => string;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
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

/**
 * After the staged plugin tree has been scanned, symlink the host openclaw
 * package for plugins that declare it as a peer dependency.
 */
async function linkOpenClawPeerDependencies(params: {
  installedDir: string;
  peerDependencies: Record<string, string>;
  logger: PluginInstallLogger;
}): Promise<void> {
  const peers = Object.keys(params.peerDependencies).filter((name) => name === "openclaw");
  if (peers.length === 0) {
    return;
  }

  const hostRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
    cwd: process.cwd(),
  });
  if (!hostRoot) {
    params.logger.warn?.(
      "Could not locate openclaw package root to symlink peerDependencies; plugin may fail to resolve openclaw at runtime.",
    );
    return;
  }

  const nodeModulesDir = path.join(params.installedDir, "node_modules");
  await fs.mkdir(nodeModulesDir, { recursive: true });

  for (const peerName of peers) {
    const linkPath = path.join(nodeModulesDir, peerName);

    try {
      // Remove any existing entry (broken link or stale directory) before
      // creating the new symlink so re-installs are idempotent.
      await fs.rm(linkPath, { recursive: true, force: true });
      await fs.symlink(hostRoot, linkPath, "junction");
      params.logger.info?.(`Linked peerDependency "${peerName}" -> ${hostRoot}`);
    } catch (err) {
      params.logger.warn?.(`Failed to symlink peerDependency "${peerName}": ${String(err)}`);
    }
  }
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

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await runtime.readJsonFile<PackageManifest>(manifestPath);
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

  // Prefer the canonical `id` from openclaw.plugin.json over the npm package name.
  // This avoids a latent key-mismatch bug: if the manifest id (e.g. "memory-cognee")
  // differs from the npm package name (e.g. "cognee-openclaw"), the plugin registry
  // uses the manifest id as the authoritative key, so the config entry must match it.
  const ocManifestResult = runtime.loadPluginManifest(params.packageDir);
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
    logger.info?.(
      `Plugin manifest id "${manifestPluginId}" differs from npm package name "${npmPluginId}"; using manifest id as the config key.`,
    );
  }

  const packageMetadata = runtime.getPackageManifestMetadata(manifest);
  const minHostVersionCheck = runtime.checkMinHostVersion({
    currentVersion: runtime.resolveCompatibilityHostVersion(),
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

  const targetResult = await resolvePreparedDirectoryInstallTarget({
    runtime,
    pluginId,
    extensionsDir: params.extensionsDir,
    requestedMode: mode,
    nameEncoder: encodePluginInstallDirName,
  });
  if (!targetResult.ok) {
    return { ok: false, error: targetResult.error };
  }

  const scanResult = await runInstallSourceScan({
    subject: `Plugin "${pluginId}"`,
    scan: async () =>
      await runtime.scanPackageInstallSource({
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        packageDir: params.packageDir,
        pluginId,
        logger,
        extensions,
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
        mode: targetResult.target.effectiveMode,
        packageName: pkgName || undefined,
        manifestId: manifestPluginId,
        version: typeof manifest.version === "string" ? manifest.version : undefined,
      }),
  });
  if (scanResult) {
    return scanResult;
  }

  const deps = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };
  const peerDeps = manifest.peerDependencies ?? {};
  return await installPluginDirectoryIntoExtensions({
    sourceDir: params.packageDir,
    pluginId,
    manifestName: pkgName || undefined,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    extensions,
    targetDir: targetResult.target.targetPath,
    extensionsDir: params.extensionsDir,
    logger,
    timeoutMs,
    mode: targetResult.target.effectiveMode,
    dryRun,
    copyErrorPrefix: "failed to copy plugin",
    hasDeps: Object.keys(deps).length > 0,
    depsLogMessage: "Installing plugin dependencies…",
    nameEncoder: encodePluginInstallDirName,
    afterCopy: async (installedDir) => {
      for (const entry of extensions) {
        const resolvedEntry = path.resolve(installedDir, entry);
        if (!runtime.isPathInside(installedDir, resolvedEntry)) {
          logger.warn?.(`extension entry escapes plugin directory: ${entry}`);
          continue;
        }
        if (!(await runtime.fileExists(resolvedEntry))) {
          logger.warn?.(`extension entry not found: ${entry}`);
        }
      }
    },
    afterInstall: async (installedDir) => {
      // Run the dependency-tree security scan BEFORE linking peer deps.
      // The scan rejects any node_modules/ symlink whose target resolves
      // outside the install root — a rule our trusted host-openclaw link
      // would fail by design. Running the scan first also keeps the check
      // honest against malicious plugins, because any pre-existing symlink
      // smuggled in by the source would still be present when we walk.
      const scanResult = await runInstallSourceScan({
        subject: `Plugin "${pluginId}"`,
        scan: async () =>
          await runtime.scanInstalledPackageDependencyTree({
            logger,
            packageDir: installedDir,
            pluginId,
          }),
      });
      if (scanResult) {
        return scanResult;
      }
      await linkOpenClawPeerDependencies({
        installedDir,
        peerDependencies: peerDeps,
        logger,
      });
      return null;
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
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const base = path.basename(filePath, path.extname(filePath));
  const pluginId = base || "plugin";
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  const targetFile = path.join(extensionsDir, `${safeFileName(pluginId)}${path.extname(filePath)}`);
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
    await runtime.writeFileFromPathWithinRoot({
      rootDir: extensionsDir,
      relativePath: path.basename(preparedTarget.targetPath),
      sourcePath: filePath,
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  return buildFileInstallResult(pluginId, preparedTarget.targetPath);
}

export async function installPluginFromNpmSpec(
  params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
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

  logger.info?.(`Downloading ${spec}…`);
  const installPolicyRequest: PluginInstallPolicyRequest = {
    kind: "plugin-npm",
    requestedSpecifier: spec,
  };
  const flowResult = await runtime.installFromNpmSpecArchiveWithInstaller({
    tempDirPrefix: "openclaw-npm-pack-",
    spec,
    timeoutMs,
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => {
      logger.warn?.(message);
    },
    installFromArchive: installPluginFromArchive,
    archiveInstallParams: {
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      extensionsDir: params.extensionsDir,
      timeoutMs,
      logger,
      mode,
      dryRun,
      expectedPluginId,
      installPolicyRequest,
    },
  });
  const finalized = runtime.finalizeNpmSpecArchiveInstall(flowResult);
  if (!finalized.ok && isNpmPackageNotFoundMessage(finalized.error)) {
    return {
      ok: false,
      error: finalized.error,
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
    };
  }
  return finalized;
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
