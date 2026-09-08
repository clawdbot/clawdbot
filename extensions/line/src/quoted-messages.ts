// Line plugin module remembers what an inbound quote points at.
import type { webhook } from "@line/bot-sdk";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { truncateCodePoints } from "openclaw/plugin-sdk/text-utility-runtime";

/** One message a later quote can name, as this account already knew it. */
export type LineQuotedMessage = {
  /**
   * The text this conversation already admitted, as the agent was given it. This
   * store outlives both the chat window and the prompt, so a body here can be
   * older than anything still visible; only a message this account sent has none.
   */
  body?: string;
  /** LINE user id of the sender; absent for a message this account sent. */
  senderId?: string;
  /** True when this account sent the message itself. */
  fromBot: boolean;
};

/**
 * A stored answer plus the conversation allowed to receive it. Events whose source
 * names nothing share one bucket, which needs a signed webhook with no source.
 */
type LineInboundRecord = { quoted: LineQuotedMessage; conversationId: string };

// LINE's webhook names a quoted message by id alone, so answering "what was quoted"
// means remembering what passed through. In memory on purpose: after a restart a
// quote resolves to the id LINE carries rather than to a stale body.
const MESSAGE_LIMIT = 500;

// LINE's own text limit, deliberately above the prompt's cap: shortening a quote
// for the model belongs to the prompt layer. Counted in code points as LINE counts
// it, so emoji are not cut at half the length LINE accepted.
const QUOTED_BODY_MAX_CODE_POINTS = 5000;

// Per account, and sent ids apart from received ones: a busy account must not evict
// a quiet one's entries, and one shared bound would let a group's inbound burst
// evict the bot's own ids, silently ending quote-the-bot as a way of addressing it.
const sentByAccount = new Map<string, Map<string, true>>();
const receivedByAccount = new Map<string, Map<string, LineInboundRecord>>();

function remember<T>(
  registry: Map<string, Map<string, T>>,
  accountId: string,
  messageId: string,
  value: T,
  limit: number,
): void {
  if (!messageId) {
    return;
  }
  const entries = registry.get(accountId) ?? new Map<string, T>();
  registry.set(accountId, entries);
  // Delete first so a message seen again is re-seated against insertion-order eviction.
  entries.delete(messageId);
  entries.set(messageId, value);
  pruneMapToMaxSize(entries, limit);
}

/** Records the ids of messages this account just sent. */
export function recordLineSentMessages(accountId: string, messageIds: readonly string[]): void {
  for (const messageId of messageIds) {
    remember(sentByAccount, accountId, messageId, true, MESSAGE_LIMIT);
  }
}

/**
 * Records an admitted inbound message on its way to the agent. Admission, not the
 * turn's outcome, is the boundary: a failed turn does not roll the ambient window
 * back, and a message the allowlist turned away never reaches this at all.
 */
export function recordLineAgentVisibleMessage(
  accountId: string,
  message: { id: string; conversationId: string; body?: string; senderId?: string },
): void {
  const body = message.body
    ? truncateCodePoints(message.body, QUOTED_BODY_MAX_CODE_POINTS)
    : undefined;
  remember(
    receivedByAccount,
    accountId,
    message.id,
    {
      conversationId: message.conversationId,
      quoted: {
        fromBot: false,
        ...(body ? { body } : {}),
        ...(message.senderId ? { senderId: message.senderId } : {}),
      },
    },
    MESSAGE_LIMIT,
  );
}

/**
 * Resolves what a quoted message id names, or undefined once it has aged out.
 * An id this account sent answers anywhere, since recognizing its own message is
 * how the bot reads a quote as being addressed. A received message answers only
 * inside the conversation it was seen in: message ids are account-wide, so the
 * conversation is what keeps one chat's text out of another's prompt rather than
 * a platform promise we cannot check.
 */
export function resolveLineQuotedMessage(
  accountId: string,
  quotedMessageId: string | undefined,
  conversationId: string,
): LineQuotedMessage | undefined {
  if (!quotedMessageId) {
    return undefined;
  }
  if (sentByAccount.get(accountId)?.has(quotedMessageId)) {
    return { fromBot: true };
  }
  const received = receivedByAccount.get(accountId)?.get(quotedMessageId);
  return received?.conversationId === conversationId ? received.quoted : undefined;
}

/** Reads the quoted message id LINE reports on the message kinds a person can quote from. */
export function readLineQuotedMessageId(
  message: webhook.MessageEvent["message"],
): string | undefined {
  return message.type === "text" || message.type === "sticker"
    ? message.quotedMessageId
    : undefined;
}
