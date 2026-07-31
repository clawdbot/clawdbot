// Msteams plugin module implements graph messages behavior.
import type { OpenClawConfig } from "../runtime-api.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import { stripHtmlFromTeamsMessage } from "./graph-thread.js";
import {
  deleteGraphRequest,
  fetchGraphAbsoluteUrl,
  fetchGraphJson,
  postGraphBetaJson,
  postGraphJson,
  resolveGraphToken,
} from "./graph.js";
import { getMSTeamsReactionEmoji, resolveMSTeamsReactionEmoji } from "./reaction-types.js";

type GraphMessageBody = {
  content?: string;
  contentType?: string;
};

type GraphMessageFrom = {
  user?: { id?: string; displayName?: string };
  application?: { id?: string; displayName?: string };
};

type GraphMessage = {
  id?: string;
  body?: GraphMessageBody;
  from?: GraphMessageFrom;
  createdDateTime?: string;
};

type GraphPinnedMessage = {
  id?: string;
  message?: GraphMessage;
};

type GraphPinnedMessagesResponse = {
  value?: GraphPinnedMessage[];
  "@odata.nextLink"?: string;
};

/**
 * Resolve the Graph API path prefix for a conversation.
 * If `to` contains "/" it's a `teamId/channelId` (channel path),
 * otherwise it's a chat ID.
 */
/**
 * Strip common target prefixes (`conversation:`, `user:`) so raw
 * conversation IDs can be used directly in Graph paths.
 */
function stripTargetPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (/^conversation:/i.test(trimmed)) {
    return trimmed.slice("conversation:".length).trim();
  }
  if (/^user:/i.test(trimmed)) {
    return trimmed.slice("user:".length).trim();
  }
  return trimmed;
}

/**
 * Resolve a target to a Graph-compatible conversation ID.
 * `user:<aadId>` targets are looked up in the conversation store to find the
 * actual `19:xxx@thread.*` chat ID that Graph API requires.
 * Conversation IDs and `teamId/channelId` pairs pass through unchanged.
 */
export async function resolveGraphConversationId(to: string): Promise<string> {
  const trimmed = to.trim();
  const isUserTarget = /^user:/i.test(trimmed);
  const cleaned = stripTargetPrefix(trimmed);

  // teamId/channelId or already a conversation ID (19:xxx) — use directly
  if (!isUserTarget) {
    return cleaned;
  }

  // user:<aadId> — look up the conversation store for the real chat ID
  const store = createMSTeamsConversationStoreState();
  const found = await store.findPreferredDmByUserId(cleaned);
  if (!found) {
    throw new Error(
      `No conversation found for user:${cleaned}. ` +
        "The bot must receive a message from this user before Graph API operations work.",
    );
  }

  if (found.conversationId.startsWith("19:")) {
    return found.conversationId;
  }
  throw new Error(
    `Conversation for user:${cleaned} uses a Bot Framework ID (${found.conversationId}) ` +
      "that Graph API does not accept. Use a Graph-native conversation:19:... target when available.",
  );
}

export function resolveConversationPath(to: string): {
  kind: "chat" | "channel";
  basePath: string;
  chatId?: string;
  teamId?: string;
  channelId?: string;
} {
  const cleaned = stripTargetPrefix(to);
  const separatorIndex = cleaned.indexOf("/");
  if (separatorIndex !== -1) {
    const teamId = cleaned.slice(0, separatorIndex);
    const channelId = cleaned.slice(separatorIndex + 1).replace(/\/.*$/, "");
    return {
      kind: "channel",
      basePath: `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`,
      teamId,
      channelId,
    };
  }
  // Conversation IDs like 19:xxx@thread.tacv2 may represent either group chats
  // or channel threads. Without a teamId/channelId pair (format "teamId/channelId")
  // we route through /chats/{id} which works for group chats and 1:1 DMs.
  // Channel operations that require /teams/{teamId}/channels/{channelId} paths
  // must be called with the explicit teamId/channelId target format.
  return {
    kind: "chat",
    basePath: `/chats/${encodeURIComponent(cleaned)}`,
    chatId: cleaned,
  };
}

type GetMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

type GetMessageMSTeamsResult = {
  id: string;
  text: string | undefined;
  from: GraphMessageFrom | undefined;
  createdAt: string | undefined;
};

/**
 * Retrieve a single message by ID from a chat or channel via Graph API.
 */
export async function getMessageMSTeams(
  params: GetMessageMSTeamsParams,
): Promise<GetMessageMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}`;
  const msg = await fetchGraphJson<GraphMessage>({ token, path });
  return {
    id: msg.id ?? params.messageId,
    text: msg.body?.content,
    from: msg.from,
    createdAt: msg.createdDateTime,
  };
}

type PinMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

/**
 * Pin a message in a chat conversation via Graph API.
 *
 * Chat pinning uses the v1.0 endpoint: `POST /chats/{chatId}/pinnedMessages`.
 *
 * Channel pinning uses `POST /teams/{teamId}/channels/{channelId}/pinnedMessages`.
 * **Note:** The channel pin endpoint may require the Graph beta API or specific
 * tenant-level permissions. As of March 2026, general availability is not
 * confirmed for all tenants. If the call returns 404 or 403, the endpoint may
 * not be enabled for the target tenant.
 */
export async function pinMessageMSTeams(
  params: PinMessageMSTeamsParams,
): Promise<{ ok: true; pinnedMessageId?: string }> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);

  if (conv.kind === "channel") {
    // Graph v1.0 does not expose pinnedMessages on channels — only on chats.
    // Attempting this would 404.
    throw new Error(
      "Pin/unpin is not supported for channel messages on Graph v1.0. " +
        "Only chat conversations support pinned messages.",
    );
  }

  // Graph API expects message@odata.bind with the full message resource URI
  const body = {
    "message@odata.bind": `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(params.messageId)}`,
  };
  const result = await postGraphJson<{ id?: string }>({
    token,
    path: `${conv.basePath}/pinnedMessages`,
    body,
  });
  return { ok: true, pinnedMessageId: result.id };
}

type UnpinMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  /** The pinned-message resource ID returned by pin or list-pins (not the message ID). */
  pinnedMessageId: string;
};

/**
 * Unpin a message in a chat conversation via Graph API.
 * `pinnedMessageId` is the pinned-message resource ID (from pin or list-pins),
 * not the underlying chat message ID.
 *
 * Channel unpin uses `DELETE /teams/{teamId}/channels/{channelId}/pinnedMessages/{id}`.
 * See the note on {@link pinMessageMSTeams} regarding beta/GA status.
 */
export async function unpinMessageMSTeams(
  params: UnpinMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);
  if (conv.kind === "channel") {
    throw new Error(
      "Pin/unpin is not supported for channel messages on Graph v1.0. " +
        "Only chat conversations support pinned messages.",
    );
  }
  const path = `${conv.basePath}/pinnedMessages/${encodeURIComponent(params.pinnedMessageId)}`;
  await deleteGraphRequest({ token, path });
  return { ok: true };
}

type ListPinsMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
};

type ListPinsMSTeamsResult = {
  pins: Array<{ id: string; pinnedMessageId: string; messageId?: string; text?: string }>;
};

/** Maximum number of pagination pages to follow to avoid unbounded loops. */
const LIST_PINS_MAX_PAGES = 10;

/**
 * List all pinned messages in a chat conversation via Graph API.
 * Follows `@odata.nextLink` pagination to collect the full pin set.
 *
 * Channel list-pins uses the same endpoint pattern as channel pin/unpin.
 * See the note on {@link pinMessageMSTeams} regarding beta/GA status.
 */
export async function listPinsMSTeams(
  params: ListPinsMSTeamsParams,
): Promise<ListPinsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);

  if (conv.kind === "channel") {
    throw new Error(
      "Listing pinned messages is not supported for channels on Graph v1.0. " +
        "Only chat conversations support pinned messages.",
    );
  }

  const path = `${conv.basePath}/pinnedMessages?$expand=message`;
  const allPins: Array<{ id: string; pinnedMessageId: string; messageId?: string; text?: string }> =
    [];

  let res = await fetchGraphJson<GraphPinnedMessagesResponse>({ token, path });
  let pages = 1;

  while (true) {
    for (const pin of res.value ?? []) {
      allPins.push({
        id: pin.id ?? "",
        pinnedMessageId: pin.id ?? "",
        messageId: pin.message?.id,
        text: pin.message?.body?.content,
      });
    }

    const nextLink = res["@odata.nextLink"];
    if (!nextLink || pages >= LIST_PINS_MAX_PAGES) {
      break;
    }

    res = await fetchGraphAbsoluteUrl<GraphPinnedMessagesResponse>({ token, url: nextLink });
    pages++;
  }

  return { pins: allPins };
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

type GraphReaction = {
  reactionType?: string;
  user?: { id?: string; displayName?: string };
  createdDateTime?: string;
};

type GraphMessageWithReactions = GraphMessage & {
  reactions?: GraphReaction[];
};

type ReactMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
  reactionType: string;
};

type ListReactionsMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

type ReactionSummary = {
  reactionType: string;
  /** Display name for the reaction (matches reactionType for known types). */
  name: string;
  /** Emoji representation when available. */
  emoji?: string;
  count: number;
  users: Array<{ id: string; displayName?: string }>;
};

type ListReactionsMSTeamsResult = {
  reactions: ReactionSummary[];
};

/**
 * Add an emoji reaction to a message via Graph API (beta).
 *
 * Writes (setReaction) require a Delegated token, so we pass
 * `preferDelegated: true`. The resolver falls back to the app-only token when
 * delegated auth is not configured, preserving today's behavior while letting
 * delegated-auth-enabled deployments hit the user-scoped endpoint.
 */
export async function reactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const reactionType = resolveMSTeamsReactionEmoji(params.reactionType);
  const token = await resolveGraphToken(params.cfg, { preferDelegated: true });
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/setReaction`;
  await postGraphBetaJson<unknown>({ token, path, body: { reactionType } });
  return { ok: true };
}

/**
 * Remove an emoji reaction from a message via Graph API (beta).
 *
 * Writes (unsetReaction) require a Delegated token, so we pass
 * `preferDelegated: true`. See `reactMessageMSTeams` for fallback rules.
 */
export async function unreactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<{ ok: true }> {
  const reactionType = resolveMSTeamsReactionEmoji(params.reactionType);
  const token = await resolveGraphToken(params.cfg, { preferDelegated: true });
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/unsetReaction`;
  await postGraphBetaJson<unknown>({ token, path, body: { reactionType } });
  return { ok: true };
}

/**
 * List reactions on a message, grouped by type.
 * Uses Graph v1.0 (reactions are included in the message resource).
 */
export async function listReactionsMSTeams(
  params: ListReactionsMSTeamsParams,
): Promise<ListReactionsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}`;
  const msg = await fetchGraphJson<GraphMessageWithReactions>({ token, path });

  const grouped = new Map<
    string,
    { count: number; users: Array<{ id: string; displayName?: string }> }
  >();
  for (const reaction of msg.reactions ?? []) {
    const type = reaction.reactionType ?? "unknown";
    if (!grouped.has(type)) {
      grouped.set(type, { count: 0, users: [] });
    }
    const group = grouped.get(type)!;
    // Count every reaction regardless of whether the user ID is present
    // (deleted accounts, guests, or anonymous users may lack a user ID)
    group.count++;
    if (reaction.user?.id) {
      group.users.push({
        id: reaction.user.id,
        displayName: reaction.user.displayName,
      });
    }
  }

  const reactions: ReactionSummary[] = Array.from(grouped.entries()).map(([type, group]) => ({
    reactionType: type,
    name: type,
    emoji: getMSTeamsReactionEmoji(type),
    count: group.count,
    users: group.users,
  }));

  return { reactions };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

type SearchMessagesMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  query: string;
  from?: string;
  limit?: number;
};

type SearchMessagesMSTeamsResult = {
  messages: Array<{
    id: string;
    text: string | undefined;
    from: GraphMessageFrom | undefined;
    createdAt: string | undefined;
  }>;
  truncated: boolean;
};

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGES = 10;

type GraphMessagesPage = {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
};

function normalizeSearchText(message: GraphMessage): string {
  const content = message.body?.content ?? "";
  return message.body?.contentType?.toLowerCase() === "html"
    ? stripHtmlFromTeamsMessage(content)
    : content.trim();
}

function matchesSearchSender(message: GraphMessage, from: string | undefined): boolean {
  const normalized = from?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const sender = message.from?.user ?? message.from?.application;
  return [sender?.id, sender?.displayName].some(
    (value) => value?.trim().toLowerCase() === normalized,
  );
}

/**
 * Search messages within one already-authorized chat or channel.
 * Graph does not support collection `$search` here, so filter bounded pages
 * locally without widening the read to the account's global message index.
 */
export async function searchMessagesMSTeams(
  params: SearchMessagesMSTeamsParams,
): Promise<SearchMessagesMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const { basePath } = resolveConversationPath(conversationId);

  const rawLimit = params.limit ?? SEARCH_DEFAULT_LIMIT;
  const top = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT;
  const query = params.query.trim().toLowerCase();
  const messages: SearchMessagesMSTeamsResult["messages"] = [];
  let nextUrl: string | undefined;
  let truncated = false;

  for (let page = 0; page < SEARCH_MAX_PAGES; page++) {
    const response: GraphMessagesPage = nextUrl
      ? await fetchGraphAbsoluteUrl<GraphMessagesPage>({ token, url: nextUrl })
      : await fetchGraphJson<GraphMessagesPage>({
          token,
          path: `${basePath}/messages?$top=${SEARCH_PAGE_SIZE}`,
        });

    for (const message of response.value ?? []) {
      const searchText = normalizeSearchText(message);
      if (searchText.toLowerCase().includes(query) && matchesSearchSender(message, params.from)) {
        if (messages.length >= top) {
          return { messages, truncated: true };
        }
        messages.push({
          id: message.id ?? "",
          text: message.body?.content,
          from: message.from,
          createdAt: message.createdDateTime,
        });
      }
    }

    nextUrl = response["@odata.nextLink"];
    if (messages.length >= top) {
      return { messages, truncated: Boolean(nextUrl) };
    }
    if (!nextUrl) {
      return { messages, truncated: false };
    }
    truncated = page === SEARCH_MAX_PAGES - 1;
  }

  return { messages, truncated };
}
