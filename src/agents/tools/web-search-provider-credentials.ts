/**
 * Web-search provider credential resolver.
 *
 * Reads config values, env-backed secret refs, and provider-specific environment variables.
 */
import { normalizeSecretInputString, resolveSecretInputRef } from "../../config/types.secrets.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";

/**
 * Resolves web-search provider credentials from config values, secret refs, or
 * provider-specific environment variables.
 */
/** Returns the first usable credential for a web-search provider. */
export function resolveWebSearchProviderCredential(params: {
  credentialValue: unknown;
  path: string;
  envVars: string[];
}): string | undefined {
  const fromConfigRaw = normalizeSecretInputString(params.credentialValue);
  const fromConfig = normalizeSecretInput(fromConfigRaw);
  if (fromConfig) {
    return fromConfig;
  }

  const credentialRef = resolveSecretInputRef({ value: params.credentialValue }).ref;
  if (credentialRef) {
    if (credentialRef.source !== "env") {
      // Web-search providers only accept concrete env-backed values at runtime.
      return undefined;
    }
    const fromEnvRef = normalizeSecretInput(process.env[credentialRef.id]);
    if (fromEnvRef) {
      return fromEnvRef;
    }
    return undefined;
  }

  for (const envVar of params.envVars) {
    const fromEnv = normalizeSecretInput(process.env[envVar]);
    if (fromEnv) {
      return fromEnv;
    }
  }

  return undefined;
}
