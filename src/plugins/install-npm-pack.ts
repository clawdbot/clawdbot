import fs from "node:fs/promises";
import path from "node:path";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import {
  resolveNpmPackArchiveMetadata,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import { parseRegistryNpmSpec, validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import { resolveManagedNpmInstallTarget } from "./install-managed-npm-state.js";
import { installPluginFromManagedNpmRoot } from "./install-managed-npm.js";
import { resolveDefaultPluginNpmDir, safePluginInstallFileName } from "./install-paths.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import {
  defaultLogger,
  emitSuccessfulPluginInstallSecurityEvent,
  loadPluginInstallRuntime,
} from "./install-shared.js";
import { copyPluginInstallTransactionRequest } from "./install-transaction.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type PluginInstallArtifactConsentHandler,
  type PluginInstallErrorCode,
  type PluginInstallLogger,
  type PluginNpmIntegrityDriftParams,
} from "./install-types.js";

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
}): Promise<{ dependencySpec: string }> {
  const archiveStoreDir = path.join(params.npmRoot, MANAGED_NPM_PACK_ARCHIVE_DIR);
  const identity = params.integrity ?? params.shasum ?? params.tarballName;
  const identitySlug = sha256HexPrefixCore(identity, 16);
  const packageSlug = safePluginInstallFileName(params.packageName) || "plugin";
  const versionSlug = safePluginInstallFileName(params.version ?? "pack") || "pack";
  const archiveFileName = `${packageSlug}-${versionSlug}-${identitySlug}.tgz`;
  await fs.mkdir(archiveStoreDir, { recursive: true });
  await fs.copyFile(params.archivePath, path.join(archiveStoreDir, archiveFileName));
  return {
    dependencySpec: `file:./${path.posix.join(MANAGED_NPM_PACK_ARCHIVE_DIR, archiveFileName)}`,
  };
}

export async function installPluginFromNpmPackArchive(
  params: InstallSafetyOverrides & {
    archivePath: string;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
    onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
    beforePersistentApply?: () => void;
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
    signal: params.signal,
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
  const { mode: policyMode } = await resolveManagedNpmInstallTarget({
    runtime,
    npmBaseDir,
    packageName,
    requestedMode: mode,
  });

  const result = await installPluginFromManagedNpmRoot(
    copyPluginInstallTransactionRequest(params, {
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      onInstallPolicyWarning: params.onInstallPolicyWarning,
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
      signal: params.signal,
      logger,
      mode,
      dryRun,
      expectedPluginId: params.expectedPluginId,
      onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
      beforePersistentApply: params.beforePersistentApply,
      npmResolution,
      ...(driftResult.integrityDrift ? { integrityDrift: driftResult.integrityDrift } : {}),
    }),
  );
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
