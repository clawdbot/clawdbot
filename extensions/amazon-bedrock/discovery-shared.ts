/**
 * Shared Amazon Bedrock discovery helpers used by plugin runtime and config
 * consumers without pulling in the AWS discovery implementation.
 */
import { resolveAwsSdkEnvVarName } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

/** Resolve the config auth marker that tells OpenClaw to use AWS SDK credentials. */
export function resolveBedrockConfigApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // When no AWS auth env marker is present, Bedrock should fall back to the
  // AWS SDK default credential chain instead of persisting a fake apiKey marker.
  return resolveAwsSdkEnvVarName(env);
}

/** Merge an implicit Bedrock provider catalog with any explicit user config. */
export function mergeImplicitBedrockProvider(params: {
  existing: ModelProviderConfig | undefined;
  implicit: ModelProviderConfig;
}): ModelProviderConfig {
  const { existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}
