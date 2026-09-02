// Line plugin module remembers what an inbound quote points at.
import type { webhook } from "@line/bot-sdk";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

/** One message a later quote can name, as this account already knew it. */
export type LineQuotedMessage = {
  /**
   * Text this account already showed the agent. A non-text message keeps the
   * marker the ambient window shows (`<image>`); only a message this account
   * sent has no body, because outbound text is never retained.
   */
  body?: string;
  /** LINE user id of the sender; absent for a message this account sent. */
  senderId?: string;
  /** True when this account sent the message itself. */
  fromBot: boolean;
};

/**
 * A stored answer plus the conversation that is allowed to receive it. An event
 * whose source names no group, room, or user shares one bucket with every other
 * such event; that needs a signed webhook with no identifiable source, so the
 * bucket is accepted rather than guarded.
 */
type LineInboundRecord = { quoted: LineQuotedMessage; conversationId: string };

// LINE's webhook reports a quoted message's id but never its author or its text,
// so the only way to answer "what was quoted" is to remember what passed through.
// Bounded and in memory on purpose: after a restart a quote resolves to its id
// alone, which is all LINE carries, rather than to a stale body.
const MESSAGE_LIMIT = 500;

// Bounds the store against a body LINE should not have accepted in the first
// place. It sits at LINE's own text limit, deliberately above the prompt's cap:
// shortening a quote for the model belongs to the prompt layer, which keeps the
// actionable tail that a cut here would drop.
const QUOTED_BODY_MAX_CHARS = 5000;

// The bounds are per account, not shared: LINE runs several configured accounts in
// one process, and a busy account must not evict a quiet one's entries or the
// quiet bot silently stops resolving quotes. The registries only grow with
// configured accounts that have actually seen a message.
//
// Sent ids and received messages are also bounded apart, one budget each. A group
// produces inbound traffic in bursts while the bot answers a handful of times, so
// one shared bound would evict the bot's own ids within minutes and quoting the
// bot would silently stop counting as addressing it.
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
 * Records an admitted inbound message on its way to the agent, either as the
 * turn's own message or as an entry in the group's ambient window. Admission,
 * not the turn's outcome, is the boundary: a failed turn does not roll the
 * ambient window back, and quotes stay answerable to match. Messages the
 * allowlist turned away never reach a caller, so a quote can only ever resolve
 * to content this conversation had already admitted.
 */
export function recordLineAgentVisibleMessage(
  accountId: string,
  message: { id: string; conversationId: string; body?: string; senderId?: string },
): void {
  const body = message.body ? truncateUtf16Safe(message.body, QUOTED_BODY_MAX_CHARS) : undefined;
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
