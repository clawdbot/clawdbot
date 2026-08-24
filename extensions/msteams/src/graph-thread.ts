// Msteams plugin module implements graph thread behavior.
import { decodeHtmlEntities } from "openclaw/plugin-sdk/html-entity-runtime";
import { fetchAllGraphPages, fetchGraphJson } from "./graph.js";
import type { MSTeamsRequestDeadline } from "./request-timeout.js";

export type GraphThreadMessage = {
  id?: string;
  from?: {
    user?: { displayName?: string; id?: string };
    application?: { displayName?: string; id?: string };
  };
  body?: { content?: string; contentType?: string };
  createdDateTime?: string;
};

/** Keep inbound thread enrichment bounded while still reaching recent replies. */
const MAX_REPLY_PAGES = 50;

function compareThreadMessagesChronologically(
  a: GraphThreadMessage,
  b: GraphThreadMessage,
): number {
  const timeDelta = Date.parse(a.createdDateTime ?? "") - Date.parse(b.createdDateTime ?? "");
  return timeDelta || (a.id ?? "").localeCompare(b.id ?? "");
}

/**
 * Strip HTML tags from Teams message content, preserving @mention display names.
 * Teams wraps mentions in <at>Name</at> tags.
 */
export function stripHtmlFromTeamsMessage(html: string): string {
  // Preserve mention display names by replacing <at>Name</at> with @Name.
  let text = html.replace(/<at[^>]*>(.*?)<\/at>/gi, "@$1");
  // Strip remaining HTML tags.
  text = text.replace(/<[^>]*>/g, " ");
  // Single-pass decoding preserves literally typed entity text such as "&lt;".
  text = decodeHtmlEntities(text).replaceAll("\u00a0", " ");
  // Normalize whitespace.
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Fetch a single channel message (the parent/root of a thread).
 * Returns undefined on error so callers can degrade gracefully.
 */
export async function fetchChannelMessage(
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
  deadline?: MSTeamsRequestDeadline,
): Promise<GraphThreadMessage | undefined> {
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}?$select=id,from,body,createdDateTime`;
  try {
    return await fetchGraphJson<GraphThreadMessage>({
      token,
      path,
      ...(deadline ? { deadline } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * Fetch a single chat message's full text via Graph and return plain text.
 *
 * Used to recover the complete quoted message for Teams quote replies: the
 * inbound blockquote only carries a Teams-truncated `preview` snippet. The
 * app-only `GET /chats/{chatId}/messages/{messageId}` endpoint IS permitted
 * with the `Chat.Read.All` application permission.
 *
 * Returns undefined on any failure so callers degrade to the truncated preview.
 */
export async function fetchChatMessageText(
  token: string,
  chatId: string,
  messageId: string,
  deadline?: MSTeamsRequestDeadline,
): Promise<string | undefined> {
  // The get-chatMessage endpoint does not support OData query params (e.g.
  // `$select`); tenants that enforce the documented contract reject the request,
  // which would silently fall back to the truncated preview. Request it plainly.
  const path = `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`;
  try {
    const msg = await fetchGraphJson<GraphThreadMessage>({
      token,
      path,
      ...(deadline ? { deadline } : {}),
    });
    const raw = msg.body?.content ?? "";
    const text = msg.body?.contentType === "html" ? stripHtmlFromTeamsMessage(raw) : raw.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch thread replies for a channel message, ordered chronologically.
 *
 * Graph caps each replies page at 50 and does not support `$orderby`. Follow
 * `@odata.nextLink`, then return the newest bounded window in chronological order.
 */
export async function fetchThreadReplies(
  token: string,
  groupId: string,
  channelId: string,
  messageId: string,
  limit = 50,
  deadline?: MSTeamsRequestDeadline,
): Promise<GraphThreadMessage[]> {
  const requestedLimit = Math.min(Math.max(limit, 1), 50);
  // Always request full pages so a small result window does not skip newer replies.
  const path = `/teams/${encodeURIComponent(groupId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/replies?$top=50&$select=id,from,body,createdDateTime`;
  const { items, truncated } = await fetchAllGraphPages<GraphThreadMessage>({
    token,
    path,
    maxPages: MAX_REPLY_PAGES,
    ...(deadline ? { deadline } : {}),
  });
  if (truncated) {
    throw new Error("MS Teams thread replies pagination did not reach the newest replies");
  }

  if (items.length <= requestedLimit) {
    return items;
  }
  // Once trimming is required, an incomplete timestamp set cannot identify the newest
  // window safely; do not present an oldest or arrival-order prefix as current context.
  const hasCompleteTimestamps = items.every((item) =>
    Number.isFinite(Date.parse(item.createdDateTime ?? "")),
  );
  if (!hasCompleteTimestamps) {
    throw new Error("MS Teams thread replies have incomplete timestamps");
  }
  return items.toSorted(compareThreadMessagesChronologically).slice(-requestedLimit);
}

/**
 * Format thread messages into a context string for the agent.
 * Skips the current message (by id) and blank messages.
 */
export function formatThreadContext(
  messages: GraphThreadMessage[],
  currentMessageId?: string,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.id && msg.id === currentMessageId) {
      continue;
    } // Skip the triggering message.
    const sender = msg.from?.user?.displayName ?? msg.from?.application?.displayName ?? "unknown";
    const contentType = msg.body?.contentType ?? "text";
    const rawContent = msg.body?.content ?? "";
    const content =
      contentType === "html" ? stripHtmlFromTeamsMessage(rawContent) : rawContent.trim();
    if (!content) {
      continue;
    }
    lines.push(`${sender}: ${content}`);
  }
  return lines.join("\n");
}
