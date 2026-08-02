/**
 * Resolves channel/account/thread run context for agent command execution.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

/** Merges explicit run context with command routing options. */
export function resolveAgentRunContext(opts: AgentCommandOpts): AgentRunContext {
  const merged: AgentRunContext = opts.runContext ? { ...opts.runContext } : {};

  const requestSenderId = normalizeOptionalString(opts.requestSenderId);
  const contextSenderId = normalizeOptionalString(merged.senderId);
  if (requestSenderId && !normalizeOptionalString(opts.requestMessageId)) {
    throw new Error("requestSenderId requires requestMessageId.");
  }
  if (requestSenderId && contextSenderId && requestSenderId !== contextSenderId) {
    throw new Error("requestSenderId must match the agent run context sender.");
  }
  if (requestSenderId) {
    // Keep the authenticated actor on the same immutable command envelope as
    // requestMessageId; reconstructed routing context must not erase hook auth.
    merged.senderId = requestSenderId;
  }

  const normalizedChannel = resolveMessageChannel(
    merged.messageChannel ?? opts.messageChannel,
    opts.replyChannel ?? opts.channel,
  );
  if (normalizedChannel) {
    merged.messageChannel = normalizedChannel;
  }

  const normalizedAccountId = normalizeAccountId(merged.accountId ?? opts.accountId);
  if (normalizedAccountId) {
    merged.accountId = normalizedAccountId;
  }

  const groupId = (merged.groupId ?? opts.groupId)?.toString().trim();
  if (groupId) {
    merged.groupId = groupId;
  }

  const groupChannel = (merged.groupChannel ?? opts.groupChannel)?.toString().trim();
  if (groupChannel) {
    merged.groupChannel = groupChannel;
  }

  const groupSpace = (merged.groupSpace ?? opts.groupSpace)?.toString().trim();
  if (groupSpace) {
    merged.groupSpace = groupSpace;
  }

  if (
    merged.currentThreadTs == null &&
    opts.threadId != null &&
    opts.threadId !== "" &&
    opts.threadId !== null
  ) {
    const threadId = stringifyRouteThreadId(opts.threadId);
    if (threadId) {
      merged.currentThreadTs = threadId;
    }
  }

  // Populate currentChannelId from the outbound target so channel threading
  // adapters can detect same-conversation auto-threading.
  if (!merged.currentChannelId && opts.to) {
    const trimmedTo = opts.to.trim();
    if (trimmedTo) {
      merged.currentChannelId = trimmedTo;
    }
  }

  return merged;
}
