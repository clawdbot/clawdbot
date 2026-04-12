// Narrow public testing surface for plugin authors.
// Keep this list additive and limited to helpers we are willing to support.

export { removeAckReactionAfterReply, shouldAckReaction } from "../channels/ack-reactions.js";
export {
  expectChannelInboundContextContract,
  primeChannelOutboundSendMock,
} from "../channels/plugins/contracts/test-helpers.js";
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
export { callGateway } from "../gateway/call.js";
export { createEmptyPluginRegistry } from "../plugins/registry.js";
export {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
export { capturePluginRegistration } from "../plugins/captured-registration.js";
export { resolveProviderPluginChoice } from "../plugins/provider-auth-choice.runtime.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { RuntimeEnv } from "../runtime.js";
export type { MockFn } from "../test-utils/vitest-mock-fn.js";
export {
  createAuthCaptureJsonFetch,
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../media-understanding/audio.test-helpers.ts";
export { isLiveTestEnabled } from "../agents/live-test-helpers.js";
export { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
export { writeSkill } from "../agents/skills.e2e-test-helpers.js";
export { __testing } from "../acp/control-plane/manager.js";
export { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
export { runAcpRuntimeAdapterContract } from "../acp/runtime/adapter-contract.testkit.js";
export { handleAcpCommand } from "../auto-reply/reply/commands-acp.js";
export { buildCommandTestParams } from "../auto-reply/reply/commands-spawn.test-harness.js";
export { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
export { jsonResponse, requestBodyText, requestUrl } from "../test-helpers/http.js";
export { mockPinnedHostnameResolution } from "../test-helpers/ssrf.js";
export { createWindowsCmdShimFixture } from "../test-helpers/windows-cmd-shim.js";
export { installCommonResolveTargetErrorCases } from "../test-helpers/resolve-target-error-cases.js";
export { sanitizeTerminalText } from "../terminal/safe-text.js";
export { withStateDirEnv } from "../test-helpers/state-dir-env.js";
export { countLines, hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
export {
  loadBundledPluginPublicSurfaceSync,
  loadBundledPluginTestApiSync,
  resolveRelativeBundledPluginPublicModuleId,
} from "../test-utils/bundled-plugin-public-surface.js";
export { expectGeneratedTokenPersistedToGatewayAuth } from "../test-utils/auth-token-assertions.js";
export { captureEnv, withEnv, withEnvAsync } from "../test-utils/env.js";
export { withFetchPreconnect, type FetchMock } from "../test-utils/fetch-mock.js";
export { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
