/** Model descriptors and prompt metadata without runtime discovery or credential policy. */
export { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
export { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
export {
  isGpt5ModelId,
  resolveGpt5PromptOverlayMode,
  resolveGpt5SystemPromptContribution,
} from "../agents/gpt5-prompt-overlay.js";
export {
  buildManifestModelProviderConfig,
  findCatalogTemplate,
} from "../plugins/provider-catalog.js";
export {
  buildFamilyForwardCompatModel,
  buildFirstTemplateModel,
} from "../plugins/provider-model-construction.js";
export { matchesExactOrPrefix } from "../plugins/provider-model-id-match.js";
