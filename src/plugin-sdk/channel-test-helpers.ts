// Channel test helper exports provide shared fixtures for plugin channel contract tests.
export { validateTestChannelConfig } from "./test-helpers/channel-config.js";
export { createDirectoryTestRuntime, expectDirectorySurface } from "./test-helpers/directory.js";
export { expectDirectoryIds, type DirectoryListFn } from "./test-helpers/directory-ids.js";
export {
  expectChannelPluginContract,
  installChannelActionsContractSuite,
  installChannelDmPolicyContractSuite,
  installChannelPluginContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
} from "./test-helpers/channel-contract-suites.js";
export {
  addTestHook,
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  withPluginRuntimeRegistryScope,
  type PluginHookRegistration,
} from "./test-helpers/outbound-delivery.js";
export {
  createTestInboundDebounceFlush,
  createPluginRuntimeMediaMock,
  createPluginRuntimeMock,
  type PluginRuntimeMediaMock,
} from "./test-helpers/plugin-runtime-mock.js";
export {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
  expectRuntimeCfgFallback,
} from "./test-helpers/send-config.js";
export { createStartAccountContext } from "./test-helpers/start-account-context.js";
export {
  abortStartedAccount,
  expectLifecyclePatch,
  expectPendingUntilAbort,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "./test-helpers/start-account-lifecycle.js";
export { expectOpenDmPolicyConfigIssue } from "./test-helpers/status-issues.js";
export {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "./test-helpers/subagent-hooks.js";
export {
  escapeRegExp,
  formatEnvelopeTimestamp,
  formatLocalEnvelopeTimestamp,
} from "./test-helpers/envelope-timestamp.js";
export { expectPairingReplyText, extractPairingCode } from "./test-helpers/pairing-reply.js";
export { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
