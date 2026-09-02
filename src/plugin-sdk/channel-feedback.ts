/**
 * Public SDK subpath for channel feedback reactions, status reactions, and logging helpers.
 */
import { shouldAckReaction as sharedAckReactionGate } from "../channels/ack-reactions.js";
export { resolveAckReaction } from "../agents/identity.js";
export {
  createAckReactionHandle,
  removeAckReactionHandleAfterReply,
  removeAckReactionAfterReply,
  shouldAckReaction,
  type AckReactionHandle,
  type AckReactionGateParams,
  type AckReactionScope,
} from "../channels/ack-reactions.js";
export { logAckFailure, logTypingFailure, type LogFn } from "../channels/logging.js";

/** @deprecated Owner policy moved into the WhatsApp plugin (#121257). */
export type WhatsAppAckReactionMode = "always" | "mentions" | "never";

/**
 * @deprecated Load-only bridge: the published WhatsApp channel package
 * (2026.7.2-beta.7 and earlier) imports this at module top level, so removing
 * it makes the installed plugin fail to load after a core upgrade. Behavior
 * preserved verbatim from the pre-#121257 owner. Remove once managed releases
 * have replaced the old npm latest/extended-stable packages and their upgrade
 * window has closed.
 */
export function shouldAckReactionForWhatsApp(params: {
  emoji: string;
  isDirect: boolean;
  isGroup: boolean;
  directEnabled: boolean;
  groupMode: WhatsAppAckReactionMode;
  wasMentioned: boolean;
  groupActivated: boolean;
}): boolean {
  if (!params.emoji) {
    return false;
  }
  if (params.isDirect) {
    return params.directEnabled;
  }
  if (!params.isGroup || params.groupMode === "never") {
    return false;
  }
  if (params.groupMode === "always") {
    return true;
  }
  return sharedAckReactionGate({
    scope: "group-mentions",
    isDirect: false,
    isGroup: true,
    isMentionableGroup: true,
    canDetectMention: true,
    effectiveWasMentioned: params.wasMentioned,
    shouldBypassMention: params.groupActivated,
  });
}
export { missingTargetError } from "../infra/outbound/target-errors.js";
export {
  BUILD_TOOL_TOKENS,
  CODING_TOOL_TOKENS,
  CONCIERGE_TOOL_TOKENS,
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  DEPLOY_TOOL_TOKENS,
  resolveToolEmoji,
  WEB_TOOL_TOKENS,
  type StatusReactionAdapter,
  type StatusReactionController,
  type StatusReactionEmojis,
  type StatusReactionTiming,
} from "../channels/status-reactions.js";
