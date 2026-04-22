// Private helper surface for the bundled msteams plugin.
// Keep this list additive and scoped to the bundled Teams surface.

import { createOptionalChannelSetupSurface } from "./channel-setup.js";

export type { ChunkMode } from "../auto-reply/chunk.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export type { ReplyPayload } from "./reply-payload.js";
export { mergeAllowlist, summarizeMapping } from "../channels/allowlists/resolve-utils.js";
export {
  resolveControlCommandGate,
  resolveDualTextControlCommandGate,
} from "../channels/command-gating.js";
export { logInboundDrop, logTypingFailure } from "../channels/logging.js";
export {
  resolveInboundMentionDecision,
  resolveMentionGating,
  resolveMentionGatingWithBypass,
} from "../channels/mention-gating.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export {
  formatAllowlistMatchMeta,
  resolveAllowlistMatchSimple,
} from "../channels/plugins/allowlist-match.js";
export {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../channels/plugins/channel-config.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export { buildMediaPayload } from "../channels/plugins/media-payload.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitSetupEntries,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export { resolveOutboundMediaUrls, resolveSendableOutboundReplyParts } from "./reply-payload.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelOutboundAdapter,
} from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export { resolveChannelContextVisibilityMode } from "../config/context-visibility.js";
export { resolveToolsBySender } from "../config/group-policy.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "../config/runtime-group-policy.js";
export type {
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyConfig,
  MarkdownTableMode,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../config/types.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "../config/types.secrets.js";
export { MSTeamsConfigSchema } from "../config/zod-schema.providers-core.js";
export { DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export type { SsrFPolicy } from "../infra/net/ssrf.js";
export { isPrivateIpAddress } from "../infra/net/ssrf.js";
export { detectMime, extensionForMime, getFileExtension } from "../media/mime.js";
export { extractOriginalFilename } from "../media/store.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "../security/dm-policy-shared.js";
export {
  evaluateSenderGroupAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "./group-access.js";
export {
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "../security/context-visibility.js";
export { formatDocsLink } from "../terminal/links.js";
export { sleep } from "../utils.js";
export { loadWebMedia } from "./web-media.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { keepHttpServerTaskAlive } from "./channel-lifecycle.core.js";
export { withFileLock } from "./file-lock.js";
export { dispatchReplyFromConfigWithSettledDispatcher } from "./inbound-reply-dispatch.js";
export { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";
export { loadOutboundMediaFromUrl } from "./outbound-media.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { resolveInboundSessionEnvelopeContext } from "../channels/session-envelope.js";
export {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  normalizeHostnameSuffixAllowlist,
} from "./ssrf-policy.js";
export {
  buildBaseChannelStatusSummary,
  buildProbeChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export { normalizeStringEntries } from "../shared/string-normalization.js";

const msteamsSetup = createOptionalChannelSetupSurface({
  channel: "msteams",
  label: "Microsoft Teams",
  npmSpec: "@openclaw/msteams",
  docsPath: "/channels/msteams",
});

export const msteamsSetupWizard = msteamsSetup.setupWizard;
export const msteamsSetupAdapter = msteamsSetup.setupAdapter;
