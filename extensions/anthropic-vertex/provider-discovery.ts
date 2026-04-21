import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildAnthropicVertexProvider } from "./provider-catalog.js";
import { hasAnthropicVertexAvailableAuth, resolveAnthropicVertexConfigApiKey } from "./region.js";

const PROVIDER_ID = "anthropic-vertex";

type AnthropicVertexProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  auth: [];
  catalog: {
    order: "simple";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runAnthropicVertexCatalog>;
  };
  resolveConfigApiKey: (params: { env: NodeJS.ProcessEnv }) => string | undefined;
};

function mergeImplicitAnthropicVertexProvider(params: {
  existing?: ModelProviderConfig;
  implicit: ModelProviderConfig;
}) {
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

function resolveImplicitAnthropicVertexProvider(params?: { env?: NodeJS.ProcessEnv }) {
  const env = params?.env ?? process.env;
  if (!hasAnthropicVertexAvailableAuth(env)) {
    return null;
  }

  return buildAnthropicVertexProvider({ env });
}

async function runAnthropicVertexCatalog(ctx: ProviderCatalogContext) {
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

export const anthropicVertexProviderDiscovery: AnthropicVertexProviderPlugin = {
  id: PROVIDER_ID,
  label: "Anthropic Vertex",
  docsPath: "/providers/models",
  auth: [],
  catalog: {
    order: "simple",
    run: runAnthropicVertexCatalog,
  },
  resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
};

export default anthropicVertexProviderDiscovery;
