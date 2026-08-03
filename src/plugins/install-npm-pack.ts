import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256HexPrefix } from "../infra/crypto-digest.js";
import {
  resolveNpmPackArchiveMetadata,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import { parseRegistryNpmSpec, validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import {
  removeEmptyDirectoryIfPresent,
  resolveManagedNpmGenerationUseForInstall,
  resolveManagedNpmRootForInstall,
  resolveManagedNpmRootPackageDir,
  type ManagedNpmRootPreparedDependency,
} from "./install-managed-npm-state.js";
import { installPluginFromManagedNpmRoot } from "./install-managed-npm.js";
import { resolveDefaultPluginNpmDir, safePluginInstallFileName } from "./install-paths.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import {
  defaultLogger,
  emitSuccessfulPluginInstallSecurityEvent,
  loadPluginInstallRuntime,
  resolveEffectiveInstallMode,
} from "./install-shared.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type PluginInstallErrorCode,
  type PluginInstallLogger,
  type PluginNpmIntegrityDriftParams,
} from "./install-types.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";

const MANAGED_NPM_PACK_ARCHIVE_DIR = "_openclaw-pack-archives";

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
