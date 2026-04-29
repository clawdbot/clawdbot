export {
  describeGithubCopilotProviderAuthContract,
  describeOpenAICodexProviderAuthContract,
  type ProviderAuthContractPluginLoader,
} from "./test-helpers/provider-auth-contract.js";
export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectedOpenaiPluginCodexCatalogEntriesWithGpt55,
  expectCodexMissingAuthHint,
  importProviderRuntimeCatalogModule,
  loadBundledPluginPublicSurface,
  loadBundledPluginPublicSurfaceSync,
  type ProviderPlugin,
} from "./test-helpers/provider-catalog.js";
export { describeProviderContracts } from "./test-helpers/provider-contract.js";
export {
  installProviderPluginContractSuite,
  installWebFetchProviderContractSuite,
  installWebSearchProviderContractSuite,
} from "./test-helpers/provider-contract-suites.js";
export {
  describeCloudflareAiGatewayProviderDiscoveryContract,
  describeGithubCopilotProviderDiscoveryContract,
  describeMinimaxProviderDiscoveryContract,
  describeModelStudioProviderDiscoveryContract,
  describeSglangProviderDiscoveryContract,
  describeVllmProviderDiscoveryContract,
  type ProviderDiscoveryContractPluginLoader,
} from "./test-helpers/provider-discovery-contract.js";
export {
  EXPECTED_FALLBACKS,
  createConfigWithFallbacks,
  createLegacyProviderConfig,
} from "./test-helpers/onboard-config.js";
export {
  expectDashscopeVideoTaskPoll,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
  resetDashscopeVideoProviderMocks,
  type DashscopeVideoProviderMocks,
} from "./test-helpers/dashscope-video-provider.js";
export {
  expectExplicitMusicGenerationCapabilities,
  expectExplicitVideoGenerationCapabilities,
} from "./test-helpers/provider-media-capability-assertions.js";
export {
  expectProviderOnboardAllowlistAlias,
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPreservesPrimary,
  expectProviderOnboardPrimaryAndFallbacks,
  expectProviderOnboardPrimaryModel,
} from "./test-helpers/provider-onboard.js";
export {
  describeAnthropicProviderRuntimeContract,
  describeGithubCopilotProviderRuntimeContract,
  describeGoogleProviderRuntimeContract,
  describeOpenAIProviderRuntimeContract,
  describeOpenRouterProviderRuntimeContract,
  describeVeniceProviderRuntimeContract,
  describeZAIProviderRuntimeContract,
  type ProviderRuntimeContractPluginLoader,
} from "./test-helpers/provider-runtime-contract.js";
export {
  describeProviderWizardChoiceResolutionContract,
  describeProviderWizardModelPickerContract,
  describeProviderWizardSetupOptionsContract,
} from "./test-helpers/provider-wizard-contract-suites.js";
export { expectPassthroughReplayPolicy } from "./test-helpers/provider-replay-policy.js";
export { createCapturedThinkingConfigStream } from "./test-helpers/stream-hooks.js";
export {
  expectOpenClawLiveTranscriptMarker,
  normalizeTranscriptForMatch,
  OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE,
  runRealtimeSttLiveTest,
  streamAudioForLiveTest,
  synthesizeElevenLabsLiveSpeech,
  waitForLiveExpectation,
} from "./test-helpers/stt-live-audio.js";
export { describeWebFetchProviderContracts } from "./test-helpers/web-fetch-provider-contract.js";
export { describeWebSearchProviderContracts } from "./test-helpers/web-search-provider-contract.js";
