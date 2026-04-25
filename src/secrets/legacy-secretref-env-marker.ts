import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  LEGACY_SECRETREF_ENV_MARKER_PREFIX,
  parseLegacySecretRefEnvMarker,
  type SecretRef,
} from "../config/types.secrets.js";
import { setPathExistingStrict } from "./path-utils.js";
import {
  discoverConfigSecretTargets,
  type DiscoveredConfigSecretTarget,
} from "./target-registry.js";

export type LegacySecretRefEnvMarkerCandidate = {
  path: string;
  pathSegments: string[];
  value: string;
  ref: SecretRef | null;
};

function isLegacySecretRefEnvMarker(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX);
}

function toCandidate(
  target: DiscoveredConfigSecretTarget,
  defaults: NonNullable<OpenClawConfig["secrets"]>["defaults"] | undefined,
): LegacySecretRefEnvMarkerCandidate | null {
  if (!isLegacySecretRefEnvMarker(target.value)) {
    return null;
  }
  return {
    path: target.path,
    pathSegments: target.pathSegments,
    value: target.value.trim(),
    ref: parseLegacySecretRefEnvMarker(target.value, defaults?.env),
  };
}

export function collectLegacySecretRefEnvMarkerCandidates(
  config: OpenClawConfig,
): LegacySecretRefEnvMarkerCandidate[] {
  const defaults = config.secrets?.defaults;
  return discoverConfigSecretTargets(config)
    .map((target) => toCandidate(target, defaults))
    .filter((candidate): candidate is LegacySecretRefEnvMarkerCandidate => candidate !== null);
}

export function migrateLegacySecretRefEnvMarkers(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const candidates = collectLegacySecretRefEnvMarkerCandidates(config).filter(
    (candidate) => candidate.ref !== null,
  );
  if (candidates.length === 0) {
    return { config, changes: [] };
  }

  const next = structuredClone(config) as OpenClawConfig & Record<string, unknown>;
  const changes: string[] = [];
  for (const candidate of candidates) {
    const ref = candidate.ref;
    if (!ref) {
      continue;
    }
    if (setPathExistingStrict(next, candidate.pathSegments, ref)) {
      changes.push(
        `Moved ${candidate.path} ${LEGACY_SECRETREF_ENV_MARKER_PREFIX}${ref.id} marker → structured env SecretRef.`,
      );
    }
  }
  return { config: next, changes };
}
