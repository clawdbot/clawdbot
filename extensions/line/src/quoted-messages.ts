// Line plugin module remembers what an inbound quote points at.
import type { webhook } from "@line/bot-sdk";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

/** One message a later quote can name, as this account already knew it. */
export type LineQuotedMessage = {
  /** Text this account already showed the agent; absent for a non-text message. */
  body?: string;
  /** LINE user id of the sender; absent for a message this account sent. */
  senderId?: string;
  /** True when this account sent the message itself. */
  fromBot: boolean;
};

// LINE's webhook reports a quoted message's id but never its author or its text,
// so the only way to answer "what was quoted" is to remember what passed through.
// Bounded and in memory on purpose: after a restart a quote resolves to its id
// alone, which is all LINE carries, rather than to a stale body.
const RECENT_MESSAGE_LIMIT = 500;

// A quoted message is context, not the turn's own input: bound the retained text
// so one 5000-character LINE message cannot dominate the store or the prompt.
const QUOTED_BODY_MAX_CHARS = 2000;

// The bound is per account, not shared: LINE runs several configured accounts in
// one process, and a busy account must not evict a quiet one's entries or the
// quiet bot silently stops resolving quotes. The registry only grows with
// configured accounts that have actually seen a message.
const recentByAccount = new Map<string, Map<string, LineQuotedMessage>>();

function remember(accountId: string, messageId: string, message: LineQuotedMessage): void {
  if (!messageId) {
    return;
  }
  const recent = recentByAccount.get(accountId) ?? new Map<string, LineQuotedMessage>();
  recentByAccount.set(accountId, recent);
  // Delete first so a message seen again is re-seated against insertion-order eviction.
  recent.delete(messageId);
  recent.set(messageId, message);
  pruneMapToMaxSize(recent, RECENT_MESSAGE_LIMIT);
}

/** Records the ids of messages this account just sent. */
export function recordLineSentMessages(accountId: string, messageIds: readonly string[]): void {
  for (const messageId of messageIds) {
    remember(accountId, messageId, { fromBot: true });
  }
}

/**
 * Records an inbound message this account has already shown the agent, either as
 * the turn's own message or as an entry in the group's ambient window. Messages
 * the allowlist turned away never reach a caller, so a quote can only ever
 * resolve to content this conversation had already surfaced.
 */
export function recordLineAgentVisibleMessage(
  accountId: string,
  message: { id: string; body?: string; senderId?: string },
): void {
  const body = message.body ? truncateUtf16Safe(message.body, QUOTED_BODY_MAX_CHARS) : undefined;
  remember(accountId, message.id, {
    fromBot: false,
    ...(body ? { body } : {}),
    ...(message.senderId ? { senderId: message.senderId } : {}),
  });
}

/** Resolves what a quoted message id names, or undefined once it has aged out. */
export function resolveLineQuotedMessage(
  accountId: string,
  quotedMessageId: string | undefined,
): LineQuotedMessage | undefined {
  if (!quotedMessageId) {
    return undefined;
  }
  return recentByAccount.get(accountId)?.get(quotedMessageId);
}

/** Reads the quoted message id LINE reports on the message kinds a person can quote from. */
export function readLineQuotedMessageId(
  message: webhook.MessageEvent["message"],
): string | undefined {
  return message.type === "text" || message.type === "sticker"
    ? message.quotedMessageId
    : undefined;
}
