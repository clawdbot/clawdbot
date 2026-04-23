import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { NATIVE_ANTHROPIC_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";
import {
  hasAnthropicVertexAvailableAuth,
  mergeImplicitAnthropicVertexProvider,
  resolveAnthropicVertexConfigApiKey,
  resolveImplicitAnthropicVertexProvider,
} from "./api.js";

const PROVIDER_ID = "anthropic-vertex";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Anthropic Vertex Provider",
  description: "Bundled Anthropic Vertex provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Anthropic Vertex",
      docsPath: "/providers/models",
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
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
        },
      },
      resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
      ...NATIVE_ANTHROPIC_REPLAY_HOOKS,
      resolveSyntheticAuth: () => {
        if (!hasAnthropicVertexAvailableAuth()) {
          return undefined;
        }
        return {
          apiKey: GCP_VERTEX_CREDENTIALS_MARKER,
          source: "gcp-vertex-credentials (ADC)",
          mode: "api-key",
        };
      },
      augmentModelCatalog: ({ config }) =>
        readConfiguredProviderCatalogEntries({
          config,
          providerId: PROVIDER_ID,
        }),
    });
  },
});
