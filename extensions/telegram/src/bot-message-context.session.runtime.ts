// Telegram plugin module implements bot message context.session behavior.
export { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
export {
  readAmbientTranscriptWatermark,
  readSessionUpdatedAt,
  resolveAmbientTranscriptWatermarkKey,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
export { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
export { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
export { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
