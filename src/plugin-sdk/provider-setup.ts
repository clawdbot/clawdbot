// Curated setup helpers for provider plugins that integrate local/self-hosted models.
export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderCatalogContext,
  ProviderDiscoveryContext,
  ProviderPrepareDynamicModelContext,
  ProviderRuntimeModel,
} from "../plugins/types.js";

export {
  applyProviderDefaultModel,
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleLocalModels,
  discoverOpenAICompatibleSelfHostedProvider,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
  promptAndConfigureOpenAICompatibleSelfHostedProviderAuth,
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../plugins/provider-self-hosted-setup.js";
