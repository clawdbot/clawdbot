/**
 * @deprecated Broad compatibility barrel for older plugin tests.
 *
 * New tests should import focused `openclaw/plugin-sdk/*` test subpaths such as
 * `plugin-test-runtime`, `channel-test-helpers`, `test-env`, or `test-fixtures`.
 */

export {
  createAckReactionHandle,
  removeAckReactionAfterReply,
  removeAckReactionHandleAfterReply,
  shouldAckReaction,
} from "../channels/ack-reactions.js";
export {
  expectChannelInboundContextContract,
  expectChannelTurnDispatchResultContract,
  primeChannelOutboundSendMock,
} from "../channels/plugins/contracts/test-helpers.js";
export {
  installChannelOutboundPayloadContractSuite,
  type OutboundPayloadHarnessParams,
} from "../channels/plugins/contracts/outbound-payload-testkit.js";
export { buildDispatchInboundCaptureMock } from "../channels/plugins/contracts/inbound-testkit.js";
export {
  createCliRuntimeCapture,
  firstWrittenJsonArg,
  spyRuntimeErrors,
  spyRuntimeJson,
  spyRuntimeLogs,
} from "../cli/test-runtime-capture.js";
export type { CliMockOutputRuntime, CliRuntimeCapture } from "../cli/test-runtime-capture.js";
export { setDefaultChannelPluginRegistryForTests } from "../commands/channel-test-registry.js";
export type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
export type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
export type { OpenClawConfig } from "../config/config.js";
export { isAtLeast, parseSemver } from "../infra/runtime-guard.js";
export { callGateway } from "../gateway/call.js";
/** @deprecated Direct outbound delivery is runtime substrate; use channel message runtime helpers. */
export { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
export {
  createEmptyPluginRegistry,
  createPluginRegistry,
  type PluginRecord,
} from "../plugins/registry.js";
export {
  providerContractLoadError,
  pluginRegistrationContractRegistry,
  resolveProviderContractProvidersForPluginIds,
  resolveWebFetchProviderContractEntriesForPluginId,
  resolveWebSearchProviderContractEntriesForPluginId,
} from "../plugins/contracts/registry.js";
export { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
export { parseMinHostVersionRequirement } from "../plugins/min-host-version.js";
export { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../plugins/provider-contract-public-artifacts.js";
export {
  expectAugmentedCodexCatalog,
  expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55,
  expectedOpenaiPluginCodexCatalogEntriesWithGpt55,
  expectCodexMissingAuthHint,
} from "../plugins/provider-runtime.test-support.js";
export {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
export { addTestHook } from "../plugins/hooks.test-helpers.js";
export {
  assertUniqueValues,
  BUNDLED_RUNTIME_SIDECAR_PATHS,
} from "../plugins/runtime-sidecar-paths.js";
export { createPluginRecord } from "../plugins/status.test-helpers.js";
export {
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
} from "../plugins/web-provider-public-artifacts.explicit.js";
export {
  getActivePluginRegistry,
  releasePinnedPluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
export {
  listImportedBundledPluginFacadeIds,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
export { capturePluginRegistration } from "../plugins/captured-registration.js";
export { runProviderCatalog } from "../plugins/provider-discovery.js";
export {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderWizardOptions,
  setProviderWizardProvidersResolverForTest,
} from "../plugins/provider-wizard.js";
export { resolveProviderPluginChoice } from "../plugins/provider-auth-choice.runtime.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { PluginHookRegistration } from "../plugins/hook-types.js";
export type { RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
export {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../media-understanding/audio.test-helpers.ts";
export {
  createSingleUserPromptMessage,
  extractNonEmptyAssistantText,
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
} from "../agents/live-test-helpers.js";
export { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
export { writeSkill } from "../agents/skills.e2e-test-helpers.js";
export {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../agents/test-helpers/agent-message-fixtures.js";
export { collectProviderApiKeys } from "../agents/live-auth-keys.js";
export { isModelNotFoundErrorMessage } from "../agents/live-model-errors.js";
export {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "../agents/pi-embedded-helpers/failover-matches.js";
export { maybeLoadShellEnvForGenerationProviders } from "../test-utils/generation-live-test-helpers.js";
export { __testing } from "../acp/control-plane/manager.js";
export { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
export { runAcpRuntimeAdapterContract } from "../acp/runtime/adapter-contract.testkit.js";
export { handleAcpCommand } from "../auto-reply/reply/commands-acp.js";
export { buildCommandTestParams } from "../auto-reply/reply/commands-spawn.test-harness.js";
export { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
export { isTruthyEnvValue } from "../infra/env.js";
export { getShellEnvAppliedKeys } from "../infra/shell-env.js";
export { encodePngRgba, fillPixel } from "../media/png-encode.js";
export {
  parseLiveCsvFilter as parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
} from "../media-generation/live-test-helpers.js";
export {
  DEFAULT_LIVE_MUSIC_MODELS,
  resolveConfiguredLiveMusicModels,
  resolveLiveMusicAuthStore,
} from "../music-generation/live-test-helpers.js";
export {
  canRunBufferBackedImageToVideoLiveLane,
  canRunBufferBackedVideoToVideoLiveLane,
  DEFAULT_LIVE_VIDEO_MODELS,
  resolveConfiguredLiveVideoModels,
  resolveLiveVideoAuthStore,
  resolveLiveVideoResolution,
} from "../video-generation/live-test-helpers.js";
export { normalizeVideoGenerationDuration } from "../video-generation/duration-support.js";
export { parseVideoGenerationModelRef } from "../video-generation/model-ref.js";
export type {
  GeneratedVideoAsset,
  VideoGenerationMode,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "../video-generation/types.js";
export { jsonResponse, requestBodyText, requestUrl } from "../test-helpers/http.js";
export { mockPinnedHostnameResolution } from "../test-helpers/ssrf.js";
export { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
export { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
export { installCommonResolveTargetErrorCases } from "../test-helpers/resolve-target-error-cases.js";
export { sanitizeTerminalText } from "../terminal/safe-text.js";
export { withStateDirEnv } from "../test-helpers/state-dir-env.js";
export { countLines, hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
export { expectGeneratedTokenPersistedToGatewayAuth } from "../test-utils/auth-token-assertions.js";
export { captureEnv, withEnv, withEnvAsync } from "../test-utils/env.js";
export { withFetchPreconnect, type FetchMock } from "../test-utils/fetch-mock.js";
export { createMockServerResponse } from "../test-utils/mock-http-response.js";
export {
  registerProviderPlugin,
  registerProviderPlugins,
  registerSingleProviderPlugin,
  requireRegisteredProvider,
  type RegisteredProviderCollections,
} from "../test-utils/plugin-registration.js";
export { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
export { withTempDir } from "../test-utils/temp-dir.js";
export { typedCases } from "../test-utils/typed-cases.js";
export { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
export { useFrozenTime, useRealTime } from "../test-utils/frozen-time.js";
export {
  createNonExitingRuntimeEnv,
  createNonExitingTypedRuntimeEnv,
  createRuntimeEnv,
  createTypedRuntimeEnv,
} from "../test-utils/plugin-runtime-env.js";
export {
  createPluginSetupWizardAdapter,
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  promptSetupWizardAllowFrom,
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
  selectFirstWizardOption,
  type WizardPrompter,
} from "../test-utils/plugin-setup-wizard.js";
export { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
export { buildPluginApi } from "../plugins/api-builder.js";
export {
  createCapturedPluginRegistration,
  type CapturedPluginRegistration,
} from "../plugins/captured-registration.js";
export { createRuntimeTaskFlow } from "../plugins/runtime/runtime-taskflow.js";
