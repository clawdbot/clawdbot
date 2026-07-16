import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import {
  scanAndLinkInstalledPackage,
  validatePackagePluginInstallSource,
} from "./install-installed-package.js";
import { encodePluginInstallDirName, validatePluginId } from "./install-paths.js";
import {
  defaultLogger,
  emitSuccessfulPluginInstallSecurityEvent,
  ensureOpenClawExtensions,
  installPluginDirectoryIntoExtensions,
  loadPluginInstallRuntime,
  readOptionalPackageManifest,
  resolvePreparedDirectoryInstallTarget,
  runInstallSourceScan,
  sourceFamilyForInstallPolicyKind,
  validateOpenClawPackageInstallCompatibility,
  type PreparedInstallTarget,
} from "./install-shared.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type InternalPackageInstallCommonParams,
  type PackageInstallCommonParams,
  type PackageManifest,
  type PluginInstallPolicyRequest,
} from "./install-types.js";

const PLUGIN_ARCHIVE_ROOT_MARKERS = [
  "package.json",
  "openclaw.plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];

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
