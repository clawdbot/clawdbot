import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { packageNameMatchesId } from "../infra/install-safe-path.js";
import type { InstallPolicySource } from "../security/install-policy.js";
import { matchesExpectedPluginId, validatePluginId } from "./install-paths.js";
import {
  buildDirectoryInstallResult,
  defaultLogger,
  emitSuccessfulPluginInstallSecurityEvent,
  ensureOpenClawExtensions,
  formatUnresolvedOpenClawPeerLinkError,
  hasPackageRuntimeDependencies,
  loadPluginInstallRuntime,
  runInstallSourceScan,
  sourceFamilyForInstallPolicyKind,
  sourceFamilyForInstallPolicySource,
  validateOpenClawPackageInstallCompatibility,
} from "./install-shared.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type PackageInstallCommonParams,
  type PackageManifest,
  type PluginInstallFailureResult,
  type PluginInstallLogger,
  type PluginInstallPolicyRequest,
} from "./install-types.js";
import { validatePackageExtensionEntriesForInstall } from "./package-entry-resolution.js";
import { linkOpenClawPeerDependencies } from "./plugin-peer-link.js";

type ValidatedPackagePlugin = {
  manifest: PackageManifest;
  pluginId: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
  hasRuntimeDependencies: boolean;
  peerDependencies: Record<string, string>;
};

export async function validatePackagePluginInstallSource(params: {
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

export async function scanAndLinkInstalledPackage(params: {
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
