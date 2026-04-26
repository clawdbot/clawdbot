import { resolveAwsSdkEnvVarName } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export function resolveBedrockConfigApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  // When no AWS auth env marker is present, Bedrock should fall back to the
  // AWS SDK default credential chain instead of persisting a fake apiKey marker.
  return resolveAwsSdkEnvVarName(env);
}

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
