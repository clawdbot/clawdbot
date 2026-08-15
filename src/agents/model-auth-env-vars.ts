/**
 * Provider auth env/evidence lookup facade for agent auth code. It keeps
 * provider-env-var source paths centralized while exposing API-key oriented
 * helper names to model/auth modules.
 */
import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthLookupMaps,
} from "../secrets/provider-env-vars.js";
import type {
  ProviderAuthEvidence,
  ProviderAuthLookupMaps,
  ProviderEnvVarLookupParams,
} from "../secrets/provider-env-vars.js";

/** Resolves both env-var candidates and richer auth evidence from one manifest snapshot. */
export function resolveProviderEnvAuthLookupMaps(
  params?: ProviderEnvVarLookupParams,
): ProviderAuthLookupMaps {
  return resolveProviderAuthLookupMaps(params);
}

/** Lists every provider key represented by either env candidates or auth evidence. */
export function listProviderEnvAuthLookupKeys(params: {
  envCandidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
}): string[] {
  // Evidence-only providers still need status/discovery rows even when they do not expose env vars.
  return Array.from(
    new Set([...Object.keys(params.envCandidateMap), ...Object.keys(params.authEvidenceMap)]),
  ).toSorted((a, b) => a.localeCompare(b));
}

/** Lists known provider API-key env var names for redaction and marker matching. */
export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
