export { discordPlugin } from "./src/channel.js";
export { discordSetupPlugin } from "./src/channel.setup.js";
export {
  handleDiscordSubagentDeliveryTarget,
  handleDiscordSubagentEnded,
  handleDiscordSubagentSpawning,
} from "./src/subagent-hooks.js";
export {
  type DiscordCredentialStatus,
  inspectDiscordAccount,
  type InspectedDiscordAccount,
} from "./src/account-inspect.js";
export {
  createDiscordActionGate,
  listDiscordAccountIds,
  listEnabledDiscordAccounts,
  mergeDiscordAccountConfig,
  type ResolvedDiscordAccount,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  resolveDiscordAccountConfig,
  resolveDiscordMaxLinesPerMessage,
} from "./src/accounts.js";
export { tryHandleDiscordMessageActionGuildAdmin } from "./src/actions/handle-action.guild-admin.js";
export { buildDiscordComponentMessage } from "./src/components.js";
type DiscordMessageActionHandler =
  typeof import("./src/channel-actions.runtime.js").handleDiscordMessageAction;

// Deprecated compatibility surface for existing @openclaw/discord/api.js consumers.
export const handleDiscordMessageAction: DiscordMessageActionHandler = async (...args) =>
  (await import("./src/channel-actions.runtime.js")).handleDiscordMessageAction(...args);
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "./src/directory-config.js";
export {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./src/group-policy.js";
export {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "./src/normalize.js";
export { resolveOpenProviderRuntimeGroupPolicy as resolveDiscordRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
export { collectDiscordStatusIssues } from "./src/status-issues.js";

export {
  buildDiscordComponentCustomId,
  buildDiscordComponentMessageFlags,
  buildDiscordInteractiveComponents,
  buildDiscordModalCustomId,
  createDiscordFormModal,
  DISCORD_COMPONENT_ATTACHMENT_PREFIX,
  DISCORD_COMPONENT_CUSTOM_ID_KEY,
  DISCORD_MODAL_CUSTOM_ID_KEY,
  DiscordFormModal,
  formatDiscordComponentEventText,
  parseDiscordComponentCustomId,
  parseDiscordComponentCustomIdForInteraction,
  parseDiscordComponentCustomIdForInteraction as parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomId,
  parseDiscordModalCustomIdForInteraction,
  parseDiscordModalCustomIdForInteraction as parseDiscordModalCustomIdForCarbon,
  readDiscordComponentSpec,
  resolveDiscordComponentAttachmentName,
  type ComponentData,
  type DiscordComponentBlock,
  type DiscordComponentBuildResult,
  type DiscordComponentButtonSpec,
  type DiscordComponentButtonStyle,
  type DiscordComponentEntry,
  type DiscordComponentMessageSpec,
  type DiscordComponentModalFieldType,
  type DiscordComponentSectionAccessory,
  type DiscordComponentSelectOption,
  type DiscordComponentSelectSpec,
  type DiscordComponentSelectType,
  type DiscordModalEntry,
  type DiscordModalFieldDefinition,
  type DiscordModalFieldSpec,
  type DiscordModalSpec,
} from "./src/components.js";
export {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
  shouldSuppressLocalDiscordExecApprovalPrompt,
} from "./src/exec-approvals.js";
export type {
  DiscordInteractiveHandlerContext,
  DiscordInteractiveHandlerRegistration,
} from "./src/interactive-dispatch.js";
export {
  type DiscordPluralKitConfig,
  fetchPluralKitMessageInfo,
  type PluralKitMemberInfo,
  type PluralKitMessageInfo,
  type PluralKitSystemInfo,
} from "./src/pluralkit.js";
export {
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  parseApplicationIdFromToken,
  probeDiscord,
  resolveDiscordPrivilegedIntentsFromFlags,
  type DiscordApplicationSummary,
  type DiscordPrivilegedIntentsSummary,
  type DiscordPrivilegedIntentStatus,
  type DiscordProbe,
} from "./src/probe.js";
export { normalizeExplicitDiscordSessionKey } from "./src/session-key-normalization.js";
export { parseDiscordSendTarget, type SendDiscordTarget } from "./src/send-target-parsing.js";
export {
  parseDiscordTarget,
  resolveDiscordChannelId,
  resolveDiscordTarget,
  type DiscordTarget,
  type DiscordTargetKind,
  type DiscordTargetParseOptions,
} from "./src/targets.js";
export { collectDiscordSecurityAuditFindings } from "./src/security-audit.js";
export {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
  mergeAbortSignals,
} from "./src/monitor/timeouts.js";
export type { DiscordSendComponents, DiscordSendEmbeds } from "./src/send.shared.js";
export type { DiscordSendResult } from "./src/send.types.js";
export type { DiscordTokenResolution } from "./src/token.js";
