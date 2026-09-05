// Resolves npm integrity metadata and detects package drift.
import type { NpmIntegrityDrift, NpmSpecResolution } from "./install-source-utils.js";

/** Payload passed to npm integrity drift handlers during archive installs. */
export type NpmIntegrityDriftPayload = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

function normalizeIntegrity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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
  const expectedIntegrity = normalizeIntegrity(params.expectedIntegrity);
  if (!expectedIntegrity) {
    return {};
  }

  const subject = params.resolution.resolvedSpec ?? params.spec;
  const actualIntegrity = normalizeIntegrity(params.resolution.integrity);
  if (!actualIntegrity) {
    return { error: `aborted: npm package integrity missing for ${subject}` };
  }
  if (expectedIntegrity === actualIntegrity) {
    return {};
  }

  const integrityDrift: NpmIntegrityDrift = { expectedIntegrity, actualIntegrity };
  const payload: NpmIntegrityDriftPayload = {
    spec: params.spec,
    expectedIntegrity,
    actualIntegrity,
    resolution: params.resolution,
  };
  let proceed = false;
  if (params.onIntegrityDrift) {
    proceed = await params.onIntegrityDrift(payload);
  } else {
    params.warn?.(
      `Integrity drift detected for ${subject}: expected ${expectedIntegrity}, got ${actualIntegrity}`,
    );
  }

  return {
    integrityDrift,
    ...(proceed ? {} : { error: `aborted: npm package integrity drift detected for ${subject}` }),
  };
}
