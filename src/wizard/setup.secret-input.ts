import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeSecretInputString, resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveSecretRefString } from "../secrets/resolve.js";

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function formatSecretResolutionError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export async function resolveSetupSecretInputString(params: {
  config: OpenClawConfig;
  value: unknown;
  path: string;
  defaults?: SecretDefaults;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const defaults = params.defaults ?? params.config.secrets?.defaults;
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults,
  });
  if (ref) {
    try {
      return await resolveSecretRefString(ref, {
        config: params.config,
        env: params.env ?? process.env,
      });
    } catch (error) {
      throw new Error(
        `${params.path}: failed to resolve SecretRef "${ref.source}:${ref.provider}:${ref.id}": ${formatSecretResolutionError(error)}`,
        { cause: error },
      );
    }
  }

  return normalizeSecretInputString(params.value);
}
