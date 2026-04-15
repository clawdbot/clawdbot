import {
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  omitEnvKeysCaseInsensitive,
  PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  PROVIDER_ENV_VARS,
} from "../secrets/provider-env-vars.js";

export {
  listKnownProviderAuthEnvVarNames,
  listKnownSecretEnvVarNames,
  omitEnvKeysCaseInsensitive,
  PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  PROVIDER_ENV_VARS,
};

export function resolveProviderAuthEnvVarCandidates(): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(PROVIDER_AUTH_ENV_VAR_CANDIDATES).map(([providerId, envVars]) => [
      providerId,
      [...envVars],
    ]),
  );
}

export function getProviderEnvVars(providerId?: string | null): string[] {
  const normalizedProviderId = providerId?.trim().toLowerCase();
  if (!normalizedProviderId) {
    return [];
  }
  const envVars =
    PROVIDER_ENV_VARS[normalizedProviderId] ?? PROVIDER_AUTH_ENV_VAR_CANDIDATES[normalizedProviderId];
  return envVars ? [...envVars] : [];
}
