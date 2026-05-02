import {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  packNpmSpecToArchive,
  withTempDir,
} from "./install-source-utils.js";
import {
  type NpmIntegrityDriftPayload,
  resolveNpmIntegrityDriftWithDefaultMessage,
} from "./npm-integrity.js";
import {
  formatPrereleaseResolutionError,
  isPrereleaseResolutionAllowed,
  parseRegistryNpmSpec,
} from "./npm-registry-spec.js";

type NpmSpecArchiveInstallFlowResult<TResult extends { ok: boolean }> =
  | {
      ok: false;
      error: string;
    }
  | {
      ok: true;
      installResult: TResult;
      npmResolution: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    };

export async function installFromNpmSpecArchiveWithInstaller<
  TResult extends { ok: boolean },
  TArchiveInstallParams extends { archivePath: string },
>(params: {
  tempDirPrefix: string;
  spec: string;
  timeoutMs: number;
  expectedIntegrity?: string;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
  installFromArchive: (params: TArchiveInstallParams) => Promise<TResult>;
  archiveInstallParams: Omit<TArchiveInstallParams, "archivePath">;
}): Promise<NpmSpecArchiveInstallFlowResult<TResult>> {
  return await installFromNpmSpecArchive({
    tempDirPrefix: params.tempDirPrefix,
    spec: params.spec,
    timeoutMs: params.timeoutMs,
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: params.warn,
    installFromArchive: async ({ archivePath }) =>
      await params.installFromArchive({
        archivePath,
        ...params.archiveInstallParams,
      } as TArchiveInstallParams),
  });
}

export type NpmSpecArchiveFinalInstallResult<TResult extends { ok: boolean }> =
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

export function finalizeNpmSpecArchiveInstall<TResult extends { ok: boolean }>(
  flowResult: NpmSpecArchiveInstallFlowResult<TResult>,
): NpmSpecArchiveFinalInstallResult<TResult> {
  if (!flowResult.ok) {
    return flowResult;
  }
  const installResult = flowResult.installResult;
  if (!isSuccessfulInstallResult(installResult)) {
    return installResult as Exclude<TResult, { ok: true }>;
  }
  const finalized: Extract<TResult, { ok: true }> & {
    npmResolution: NpmSpecResolution;
    integrityDrift?: NpmIntegrityDrift;
  } = {
    ...installResult,
    npmResolution: flowResult.npmResolution,
    ...(flowResult.integrityDrift ? { integrityDrift: flowResult.integrityDrift } : {}),
  };
  return finalized;
}

export async function installFromNpmSpecArchive<TResult extends { ok: boolean }>(params: {
  tempDirPrefix: string;
  spec: string;
  timeoutMs: number;
  expectedIntegrity?: string;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
  installFromArchive: (params: { archivePath: string }) => Promise<TResult>;
}): Promise<NpmSpecArchiveInstallFlowResult<TResult>> {
  return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
    const parsedSpec = parseRegistryNpmSpec(params.spec);
    if (!parsedSpec) {
      return {
        ok: false,
        error: "unsupported npm spec",
      };
    }
    const packedResult = await packNpmSpecToArchive({
      spec: params.spec,
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
        ok: false,
        error: formatPrereleaseResolutionError({
          spec: parsedSpec,
          resolvedVersion: npmResolution.version,
        }),
      };
    }

    const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
      spec: params.spec,
      expectedIntegrity: params.expectedIntegrity,
      resolution: npmResolution,
      onIntegrityDrift: params.onIntegrityDrift,
      warn: params.warn,
    });
    if (driftResult.error) {
      return {
        ok: false,
        error: driftResult.error,
      };
    }

    const installResult = await params.installFromArchive({
      archivePath: packedResult.archivePath,
    });

    return {
      ok: true,
      installResult,
      npmResolution,
      integrityDrift: driftResult.integrityDrift,
    };
  });
}
