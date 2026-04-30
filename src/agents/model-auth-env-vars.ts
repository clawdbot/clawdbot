import {
  listKnownProviderAuthEnvVarNames,
  resolveProviderAuthEvidence,
  resolveProviderAuthEnvVarCandidates,
} from "../secrets/provider-env-vars.js";
import type {
  ProviderAuthEvidence,
  ProviderEnvVarLookupParams,
} from "../secrets/provider-env-vars.js";

export function resolveProviderEnvApiKeyCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return resolveProviderAuthEnvVarCandidates(params);
}

export function resolveProviderEnvAuthEvidence(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly ProviderAuthEvidence[]> {
  return resolveProviderAuthEvidence(params);
}

export function listProviderEnvAuthLookupKeys(params: {
  envCandidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
}): string[] {
  return Array.from(
    new Set([...Object.keys(params.envCandidateMap), ...Object.keys(params.authEvidenceMap)]),
  ).toSorted((a, b) => a.localeCompare(b));
}

export function resolveProviderEnvAuthLookupKeys(params?: ProviderEnvVarLookupParams): string[] {
  return listProviderEnvAuthLookupKeys({
    envCandidateMap: resolveProviderEnvApiKeyCandidates(params),
    authEvidenceMap: resolveProviderEnvAuthEvidence(params),
  });
}

export const PROVIDER_ENV_API_KEY_CANDIDATES = resolveProviderEnvApiKeyCandidates();

export function listKnownProviderEnvApiKeyNames(): string[] {
  return listKnownProviderAuthEnvVarNames();
}
