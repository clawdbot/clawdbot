import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildAnthropicVertexProvider } from "./provider-catalog.js";
import { hasAnthropicVertexAvailableAuth } from "./region.js";

const PROVIDER_ID = "anthropic-vertex";

/** Merge an implicit Anthropic Vertex provider with explicit user config. */
export function mergeImplicitAnthropicVertexProvider(params: {
  existing?: ModelProviderConfig;
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

/** Resolve an implicit Anthropic Vertex provider when ADC credentials are available. */
export function resolveImplicitAnthropicVertexProvider(params?: { env?: NodeJS.ProcessEnv }) {
  const env = params?.env ?? process.env;
  if (!hasAnthropicVertexAvailableAuth(env)) {
    return null;
  }

  return buildAnthropicVertexProvider({ env });
}

/** Build the shared catalog result used by discovery and the full plugin entry. */
export async function runAnthropicVertexCatalog(ctx: ProviderCatalogContext) {
  const implicit = resolveImplicitAnthropicVertexProvider({
    env: ctx.env,
  });
  if (!implicit) {
    return null;
  }
  return {
    provider: mergeImplicitAnthropicVertexProvider({
      existing: ctx.config.models?.providers?.[PROVIDER_ID],
      implicit,
    }),
  };
}
