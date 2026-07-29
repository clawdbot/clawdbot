// Installs validated registry npm specs through archive install helpers.
import type { NpmIntegrityDriftPayload } from "./npm-integrity.js";
import {
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchiveWithInstaller,
  type NpmSpecArchiveFinalInstallResult,
} from "./npm-pack-install.js";
import { validateRegistryNpmSpec } from "./npm-registry-spec.js";

/**
 * Validates a registry npm spec, downloads its archive, and delegates final installation.
 * The caller supplies archive-specific params without `archivePath`; this helper injects
 * the downloaded archive path and normalizes the npm archive flow result.
 */
export async function installFromValidatedNpmSpecArchive<
  TResult extends { ok: boolean },
  TArchiveInstallParams extends { archivePath: string },
>(params: {
  spec: string;
  timeoutMs: number;
  tempDirPrefix: string;
  expectedIntegrity?: string;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
  installFromArchive: (params: TArchiveInstallParams) => Promise<TResult>;
  archiveInstallParams: Omit<TArchiveInstallParams, "archivePath">;
}): Promise<NpmSpecArchiveFinalInstallResult<TResult>> {
  const spec = params.spec.trim();
  const specError = validateRegistryNpmSpec(spec);
  if (specError) {
    // Reject unsupported specs before any network or archive extraction work starts.
    return { ok: false, error: specError };
  }
  const flowResult = await installFromNpmSpecArchiveWithInstaller({
    tempDirPrefix: params.tempDirPrefix,
    spec,
    timeoutMs: params.timeoutMs,
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: params.warn,
    installFromArchive: params.installFromArchive,
    archiveInstallParams: params.archiveInstallParams,
  });
  return finalizeNpmSpecArchiveInstall(flowResult);
}
