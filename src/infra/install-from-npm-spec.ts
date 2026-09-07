// Installs validated registry npm specs through archive install helpers.
import {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  packNpmSpecToArchive,
  withInstallWorkspace,
} from "./install-source-utils.js";
import {
  type NpmIntegrityDriftPayload,
  resolveNpmIntegrityDriftWithDefaultMessage,
} from "./npm-integrity.js";
import {
  formatPrereleaseResolutionError,
  isPrereleaseResolutionAllowed,
  parseRegistryNpmSpec,
  validateRegistryNpmSpec,
} from "./npm-registry-spec.js";

/**
 * Final caller-facing result after a packed npm spec install.
 * Failed pack/validation results and installer failures keep their original
 * shapes; successful installs gain the npm resolution metadata.
 */
type NpmSpecArchiveFinalInstallResult<TResult extends { ok: boolean }> =
  | { ok: false; error: string }
  | Exclude<TResult, { ok: true }>
  | (Extract<TResult, { ok: true }> & {
      npmResolution: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    });

function isSuccessfulInstallResult<TResult extends { ok: boolean }>(
  result: TResult,
): result is Extract<TResult, { ok: true }> {
  return result.ok;
}

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
  const flowResult = await withInstallWorkspace(params.tempDirPrefix, async (tmpDir) => {
    const parsedSpec = parseRegistryNpmSpec(spec);
    if (!parsedSpec) {
      return {
        ok: false as const,
        error: "unsupported npm spec",
      };
    }
    // Check prerelease policy against the version the registry actually resolved.
    const packedResult = await packNpmSpecToArchive({
      spec,
      timeoutMs: params.timeoutMs,
      cwd: tmpDir,
    });
    if (!packedResult.ok) {
      return packedResult;
    }

    const npmResolution: NpmSpecResolution = {
      ...packedResult.metadata,
      resolvedAt: new Date().toISOString(),
    };
    if (
      npmResolution.version &&
      !isPrereleaseResolutionAllowed({
        spec: parsedSpec,
        resolvedVersion: npmResolution.version,
      })
    ) {
      return {
        ok: false as const,
        error: formatPrereleaseResolutionError({
          spec: parsedSpec,
          resolvedVersion: npmResolution.version,
        }),
      };
    }

    // Integrity drift is the last shared gate before extraction; installer
    // callbacks should only run for archives the caller accepted.
    const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec,
      expectedIntegrity: params.expectedIntegrity,
      resolution: npmResolution,
      onIntegrityDrift: params.onIntegrityDrift,
      warn: params.warn,
    });
    if (driftResult.error) {
      return {
        ok: false as const,
        error: driftResult.error,
      };
    }

    const installResult = await params.installFromArchive({
      archivePath: packedResult.archivePath,
      ...params.archiveInstallParams,
      // SAFETY: The caller supplies every non-path field; this owner supplies the archive path.
    } as TArchiveInstallParams);

    return {
      ok: true as const,
      installResult,
      npmResolution,
      integrityDrift: driftResult.integrityDrift,
    };
  });

  // Preserve callback results and transaction symbols only after workspace cleanup settles.
  if (!flowResult.ok) {
    return flowResult;
  }
  const installResult = flowResult.installResult;
  if (!isSuccessfulInstallResult(installResult)) {
    // SAFETY: The success guard excludes the ok:true variant from the caller result union.
    return installResult as Exclude<TResult, { ok: true }>;
  }
  return {
    ...installResult,
    npmResolution: flowResult.npmResolution,
    ...(flowResult.integrityDrift ? { integrityDrift: flowResult.integrityDrift } : {}),
  };
}
