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
export { handleDiscordMessageAction } from "./src/actions/handle-action.js";
export {
  buildDiscordComponentCustomId,
  buildDiscordComponentMessage,
  buildDiscordComponentMessageFlags,
  buildDiscordInteractiveComponents,
  buildDiscordModalCustomId,
  createDiscordFormModal,
  DISCORD_COMPONENT_ATTACHMENT_PREFIX,
  DISCORD_COMPONENT_CUSTOM_ID_KEY,
  DISCORD_MODAL_CUSTOM_ID_KEY,
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
  DiscordFormModal,
  type DiscordModalEntry,
  type DiscordModalFieldDefinition,
  type DiscordModalFieldSpec,
  type DiscordModalSpec,
  formatDiscordComponentEventText,
  parseDiscordComponentCustomId,
  parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomId,
  parseDiscordModalCustomIdForCarbon,
  readDiscordComponentSpec,
  resolveDiscordComponentAttachmentName,
} from "./src/components.js";
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
} from "./src/directory-config.js";
export {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalApprover,
  isDiscordExecApprovalClientEnabled,
  shouldSuppressLocalDiscordExecApprovalPrompt,
} from "./src/exec-approvals.js";
export {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./src/group-policy.js";
export type {
  DiscordInteractiveHandlerContext,
  DiscordInteractiveHandlerRegistration,
} from "./src/interactive-dispatch.js";
export {
  looksLikeDiscordTargetId,
  normalizeDiscordMessagingTarget,
  normalizeDiscordOutboundTarget,
} from "./src/normalize.js";
export {
  type DiscordPluralKitConfig,
  fetchPluralKitMessageInfo,
  type PluralKitMemberInfo,
  type PluralKitMessageInfo,
  type PluralKitSystemInfo,
} from "./src/pluralkit.js";
export {
  type DiscordApplicationSummary,
  type DiscordPrivilegedIntentsSummary,
  type DiscordPrivilegedIntentStatus,
  type DiscordProbe,
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  parseApplicationIdFromToken,
  probeDiscord,
  resolveDiscordPrivilegedIntentsFromFlags,
} from "./src/probe.js";
export { normalizeExplicitDiscordSessionKey } from "./src/session-key-normalization.js";
export { collectDiscordStatusIssues } from "./src/status-issues.js";
export {
  type DiscordTarget,
  type DiscordTargetKind,
  type DiscordTargetParseOptions,
  parseDiscordTarget,
  resolveDiscordChannelId,
  resolveDiscordTarget,
} from "./src/targets.js";
export { collectDiscordSecurityAuditFindings } from "./src/security-audit.js";
export { resolveDiscordRuntimeGroupPolicy } from "./src/runtime-group-policy.js";
export {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
} from "./src/monitor/timeouts.js";
export type { DiscordSendComponents, DiscordSendEmbeds } from "./src/send.shared.js";
export type { DiscordSendResult } from "./src/send.types.js";
export type { DiscordTokenResolution } from "./src/token.js";
