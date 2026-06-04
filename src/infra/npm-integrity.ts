// Resolves npm integrity metadata and detects package drift.
import type { NpmIntegrityDrift, NpmSpecResolution } from "./install-source-utils.js";

/** Payload passed to npm integrity drift handlers during archive installs. */
export type NpmIntegrityDriftPayload = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

type ResolveNpmIntegrityDriftParams<TPayload> = {
  spec: string;
  expectedIntegrity?: string;
  resolution: NpmSpecResolution;
  createPayload: (params: {
    spec: string;
    expectedIntegrity: string;
    actualIntegrity: string;
    resolution: NpmSpecResolution;
  }) => TPayload;
  onIntegrityDrift?: (payload: TPayload) => boolean | Promise<boolean>;
  warn?: (payload: TPayload) => void;
};

type ResolveNpmIntegrityDriftResult<TPayload> = {
  integrityDrift?: NpmIntegrityDrift;
  proceed: boolean;
  payload?: TPayload;
};

function normalizeIntegrity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Compares expected and resolved npm integrity values and asks the caller
 * whether a drifted archive may still be installed.
 */
export async function resolveNpmIntegrityDrift<TPayload>(
  params: ResolveNpmIntegrityDriftParams<TPayload>,
): Promise<ResolveNpmIntegrityDriftResult<TPayload>> {
  const expectedIntegrity = normalizeIntegrity(params.expectedIntegrity);
  const actualIntegrity = normalizeIntegrity(params.resolution.integrity);
  if (!expectedIntegrity || !actualIntegrity) {
    return { proceed: true };
  }
  if (expectedIntegrity === actualIntegrity) {
    return { proceed: true };
  }

  const integrityDrift: NpmIntegrityDrift = {
    expectedIntegrity,
    actualIntegrity,
  };
  const payload = params.createPayload({
    spec: params.spec,
    expectedIntegrity: integrityDrift.expectedIntegrity,
    actualIntegrity: integrityDrift.actualIntegrity,
    resolution: params.resolution,
  });

  let proceed = false;
  if (params.onIntegrityDrift) {
    proceed = await params.onIntegrityDrift(payload);
  } else {
    params.warn?.(payload);
  }

  return { integrityDrift, proceed, payload };
}

type ResolveNpmIntegrityDriftWithDefaultMessageParams = {
  spec: string;
  expectedIntegrity?: string;
  resolution: NpmSpecResolution;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
};

/**
 * Resolves integrity drift with OpenClaw's default warning and abort messages.
 * Used by npm archive installers that do not need a custom payload shape.
 */
export async function resolveNpmIntegrityDriftWithDefaultMessage(
  params: ResolveNpmIntegrityDriftWithDefaultMessageParams,
): Promise<{ integrityDrift?: NpmIntegrityDrift; error?: string }> {
  const driftResult = await resolveNpmIntegrityDrift<NpmIntegrityDriftPayload>({
    spec: params.spec,
    expectedIntegrity: params.expectedIntegrity,
    resolution: params.resolution,
    createPayload: (drift) => ({ ...drift }),
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (driftPayload) => {
      params.warn?.(
        `Integrity drift detected for ${driftPayload.resolution.resolvedSpec ?? driftPayload.spec}: expected ${driftPayload.expectedIntegrity}, got ${driftPayload.actualIntegrity}`,
      );
    },
  });

  if (!driftResult.proceed && driftResult.payload) {
    return {
      integrityDrift: driftResult.integrityDrift,
      error: `aborted: npm package integrity drift detected for ${driftResult.payload.resolution.resolvedSpec ?? driftResult.payload.spec}`,
    };
  }

  return { integrityDrift: driftResult.integrityDrift };
}
