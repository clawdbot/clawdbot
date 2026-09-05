/**
 * Anthropic Vertex provider plugin entry. It registers implicit ADC-backed
 * catalog discovery, Anthropic replay policy, thinking profiles, and auth markers.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  buildProviderReplayFamilyHooks,
  resolveClaudeThinkingProfile,
} from "openclaw/plugin-sdk/provider-model-shared";
import { hasAnthropicVertexAvailableAuth, resolveAnthropicVertexConfigApiKey } from "./api.js";
import { runAnthropicVertexCatalog } from "./provider-catalog-runtime.js";
import { normalizeAnthropicVertexResolvedModel } from "./provider-catalog.js";

const PROVIDER_ID = "anthropic-vertex";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

/** Provider entry for Anthropic Claude models served through Google Vertex AI. */
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
        run: runAnthropicVertexCatalog,
      },
      resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
      ...buildProviderReplayFamilyHooks({ family: "native-anthropic-by-model" }),
      normalizeResolvedModel: ({ modelId, model }) =>
        normalizeAnthropicVertexResolvedModel(modelId, model),
      resolveThinkingProfile: ({ modelId, params }) =>
        resolveClaudeThinkingProfile(modelId, params, { includeNativeMax: true }),
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
