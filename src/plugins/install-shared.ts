import path from "node:path";
import { satisfiesPluginApiRange } from "../infra/clawhub.js";
import type { InstallPolicySource } from "../security/install-policy.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveUserPath } from "../utils.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import type { InstallSecurityScanResult } from "./install-security-scan.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type PackageManifest,
  type PluginInstallErrorCode,
  type PluginInstallFailureResult,
  type PluginInstallLogger,
  type PluginInstallPolicyRequest,
} from "./install-types.js";
import { resolvePackageExtensionEntries, type OpenClawPackageManifest } from "./manifest.js";
import { resolvePackagePluginApiRange } from "./package-compat.js";
import {
  emitPluginAuditSecurityEvent,
  emitPluginInstallSecurityEvent,
  pluginAuditOutcomeForReason,
  type PluginSecuritySourceFamily,
} from "./security-events.js";

const pluginInstallRuntimeLoader = createLazyImportLoader(() => import("./install.runtime.js"));

export async function loadPluginInstallRuntime() {
  return await pluginInstallRuntimeLoader.load();
}

export type PluginInstallRuntime = Awaited<ReturnType<typeof loadPluginInstallRuntime>>;

export const defaultLogger: PluginInstallLogger = {};

export function formatUnresolvedOpenClawPeerLinkError(packageName: string): string {
  return `Installed plugin ${packageName} declares openclaw as a peer dependency, but OpenClaw could not create a plugin-local node_modules/openclaw link. Run from a packaged OpenClaw install or reinstall OpenClaw, then retry.`;
}

const MISSING_EXTENSIONS_ERROR =
  'package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example ["./dist/index.js"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions';
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

export function validateOpenClawPackageInstallCompatibility(params: {
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

export async function readOptionalPackageManifest(params: {
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

export function ensureOpenClawExtensions(params: { manifest: PackageManifest }):
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

export function buildDirectoryInstallResult(params: {
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

export function emitSuccessfulPluginInstallSecurityEvent(
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

export function hasPackageRuntimeDependencies(manifest: PackageManifest): boolean {
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

export function sourceFamilyForInstallPolicyKind(
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

export function sourceFamilyForInstallPolicySource(
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

export type PreparedInstallTarget = {
  targetPath: string;
  effectiveMode: "install" | "update";
};

export async function ensureInstallTargetAvailableForMode(params: {
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

export async function resolvePreparedDirectoryInstallTarget(params: {
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

export async function runInstallSourceScan(params: {
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

export async function installPluginDirectoryIntoExtensions(params: {
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

export async function resolveEffectiveInstallMode(params: {
  runtime: Awaited<ReturnType<typeof loadPluginInstallRuntime>>;
  requestedMode: "install" | "update";
  targetPath: string;
}): Promise<"install" | "update"> {
  if (params.requestedMode !== "update") {
    return "install";
  }
  return (await params.runtime.fileExists(params.targetPath)) ? "update" : "install";
}
