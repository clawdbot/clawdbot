export { createDirectoryTestRuntime, expectDirectorySurface } from "./test-helpers/directory.js";
export { expectDirectoryIds, type DirectoryListFn } from "./test-helpers/directory-ids.js";
export {
  expectChannelPluginContract,
  installChannelActionsContractSuite,
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
  releasePinnedPluginChannelRegistry,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
} from "./test-helpers/outbound-delivery.js";
/** @deprecated Direct outbound delivery is runtime substrate; use channel message runtime helpers. */
export { deliverOutboundPayloads } from "./test-helpers/outbound-delivery.js";
export { createPluginRuntimeMock } from "./test-helpers/plugin-runtime-mock.js";
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
export { assertBundledChannelEntries } from "./test-helpers/bundled-channel-entry.js";
export {
  escapeRegExp,
  formatEnvelopeTimestamp,
  formatLocalEnvelopeTimestamp,
} from "./test-helpers/envelope-timestamp.js";
export { expectPairingReplyText, extractPairingCode } from "./test-helpers/pairing-reply.js";
export { stripAnsi } from "../terminal/ansi.js";
