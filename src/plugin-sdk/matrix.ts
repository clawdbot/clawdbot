// Private helper surface for the bundled matrix plugin.
// Keep this list additive and scoped to the bundled Matrix surface.

import { createOptionalChannelSetupSurface } from "./channel-setup.js";
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

type MatrixFacadeModule = typeof import("@openclaw/matrix/contract-api.js");

function loadMatrixFacadeModule(): MatrixFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<MatrixFacadeModule>({
    dirName: "matrix",
    artifactBasename: "contract-api.js",
  });
}

export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
} from "../agents/tools/common.js";
export type { BlockReplyContext } from "../auto-reply/get-reply-options.types.js";
export type { ReplyPayload } from "../auto-reply/reply-payload.js";
export { resolveAckReaction } from "../agents/identity.js";
export {
  compileAllowlist,
  resolveCompiledAllowlistMatch,
  resolveAllowlistCandidates,
  resolveAllowlistMatchByCandidates,
} from "../channels/allowlist-match.js";
export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../channels/allowlists/resolve-utils.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export type { NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export { logInboundDrop, logTypingFailure } from "../channels/logging.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { formatAllowlistMatchMeta } from "../channels/plugins/allowlist-match.js";
export {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "../channels/plugins/channel-config.js";
export { getChatChannelMeta } from "./channel-plugin-common.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptAccountId,
  promptSingleChannelSecretInput,
  setTopLevelChannelGroupPolicy,
} from "../channels/plugins/setup-wizard-helpers.js";
export { promptChannelAccessConfig } from "../channels/plugins/setup-group-access.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  moveSingleAccountChannelSectionToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelSetupInput,
  ChannelToolSend,
} from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixOptions } from "../channels/reply-prefix.js";
export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../channels/thread-bindings-policy.js";
export {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./matrix-thread-bindings.js";
export { createTypingCallbacks } from "../channels/typing.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export { loadOutboundMediaFromUrl } from "./outbound-media.js";
export type { OpenClawConfig } from "../config/config.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type {
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  MarkdownTableMode,
} from "../config/types.js";
export type { SecretInput } from "./secret-input.js";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
export { resolveOutboundSendDep } from "../infra/outbound/send-deps.js";
export type {
  BindingTargetKind,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export { isPrivateOrLoopbackHost } from "../gateway/net.js";
export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export type { PollInput } from "../polls.js";
export { normalizePollInput } from "../polls.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { normalizeStringEntries } from "../shared/string-normalization.js";
export { formatDocsLink } from "../terminal/links.js";
export { redactSensitiveText } from "../logging/redact.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";
export { formatResolvedUnresolvedNote } from "./resolution-notes.js";
export { runPluginCommandWithTimeout } from "./run-command.js";
export { createLoggerBackedRuntime, resolveRuntimeEnv } from "./runtime.js";
export {
  buildComputedAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
} from "./status-helpers.js";
export {
  findMatrixAccountEntry,
  resolveConfiguredMatrixAccountIds,
  resolveMatrixChannelConfig,
} from "./matrix-helper.js";
export {
  resolveMatrixAccountStorageRoot,
  resolveMatrixCredentialsDir,
  resolveMatrixCredentialsPath,
  resolveMatrixLegacyFlatStoragePaths,
} from "./matrix-helper.js";
export { resolveMatrixAccountStringValues } from "./matrix-runtime-surface.js";
export { getMatrixScopedEnvVarNames } from "./matrix-helper.js";
export {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "./matrix-helper.js";
export {
  createMatrixThreadBindingManager,
  resetMatrixThreadBindingsForTests,
} from "./matrix-surface.js";
export { setMatrixRuntime } from "./matrix-runtime-surface.js";

export const singleAccountKeysToMove: MatrixFacadeModule["singleAccountKeysToMove"] =
  createLazyFacadeArrayValue(() => loadMatrixFacadeModule().singleAccountKeysToMove);

export const namedAccountPromotionKeys: MatrixFacadeModule["namedAccountPromotionKeys"] =
  createLazyFacadeArrayValue(() => loadMatrixFacadeModule().namedAccountPromotionKeys);

export const resolveSingleAccountPromotionTarget: MatrixFacadeModule["resolveSingleAccountPromotionTarget"] =
  ((...args) =>
    loadMatrixFacadeModule().resolveSingleAccountPromotionTarget(
      ...args,
    )) as MatrixFacadeModule["resolveSingleAccountPromotionTarget"];

const matrixSetup = createOptionalChannelSetupSurface({
  channel: "matrix",
  label: "Matrix",
  npmSpec: "@openclaw/matrix",
  docsPath: "/channels/matrix",
});

export const matrixSetupWizard = matrixSetup.setupWizard;
export const matrixSetupAdapter = matrixSetup.setupAdapter;
