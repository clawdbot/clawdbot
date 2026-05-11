export { whatsappPlugin } from "./src/channel.js";
export { whatsappSetupPlugin } from "./src/channel.setup.js";
export {
  DEFAULT_WHATSAPP_MEDIA_MAX_MB,
  hasAnyWhatsAppAuth,
  listEnabledWhatsAppAccounts,
  listWhatsAppAccountIds,
  listWhatsAppAuthDirs,
  resolveDefaultWhatsAppAccountId,
  type ResolvedWhatsAppAccount,
  resolveWhatsAppAccount,
  resolveWhatsAppAuthDir,
  resolveWhatsAppMediaMaxBytes,
} from "./src/accounts.js";
export { DEFAULT_WEB_MEDIA_BYTES } from "./src/auto-reply/constants.js";
export { whatsappCommandPolicy } from "./src/command-policy.js";
export {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./src/group-policy.js";
export { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./src/outbound-send-deps.js";
export {
  assertWebChannel,
  isSelfChatMode,
  jidToE164,
  markdownToWhatsApp,
  normalizeE164,
  resolveJidToE164,
  resolveUserPath,
  toWhatsappJid,
  toWhatsappJidWithLid,
  type JidToE164Options,
  type WebChannel,
} from "./src/text-runtime.js";
export {
  type WebChannelHealthState,
  type WebChannelStatus,
  type WebInboundMsg,
  type WebMonitorTuning,
} from "./src/auto-reply/types.js";
export {
  type ActiveWebListener,
  type ActiveWebSendOptions,
  type WebInboundMessage,
  type WebListenerCloseReason,
  type WhatsAppStructuredContactContext,
} from "./src/inbound/types.js";
export {
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./src/directory-config.js";
export { resolveWhatsAppOutboundTarget } from "./src/resolve-outbound-target.js";
export {
  isWhatsAppGroupJid,
  normalizeWhatsAppAllowFromEntries,
  isWhatsAppUserTarget,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./src/normalize-target.js";
export { resolveWhatsAppGroupIntroHint } from "./src/runtime-api.js";
export { __testing as whatsappAccessControlTesting } from "./src/inbound/access-control.js";
export {
  startWhatsAppQaDriverSession,
  type WhatsAppQaDriverObservedMessage,
  type WhatsAppQaDriverSession,
} from "./src/qa-driver.runtime.js";
