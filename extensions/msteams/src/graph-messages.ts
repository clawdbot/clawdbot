import type { OpenClawConfig } from "../runtime-api.js";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import {
  type GraphResponse,
  deleteGraphRequest,
  escapeOData,
  fetchGraphAbsoluteUrl,
  fetchGraphJson,
  postGraphBetaJson,
  postGraphJson,
  resolveGraphToken,
} from "./graph.js";

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

  // Prefer the cached Graph-native chat ID (19:xxx format) over the Bot Framework
  // conversation ID, which may be in a non-Graph format (a:xxx / 8:orgid:xxx) for
  // personal DMs. send-context.ts resolves and caches this on first send.
  if (found.reference.graphChatId) {
    return found.reference.graphChatId;
  }
  if (found.conversationId.startsWith("19:")) {
    return found.conversationId;
  }
  throw new Error(
    `Conversation for user:${cleaned} uses a Bot Framework ID (${found.conversationId}) ` +
      "that Graph API does not accept. Send a message to this user first so the Graph chat ID is cached.",
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
  if (cleaned.includes("/")) {
    const [teamId, channelId] = cleaned.split("/", 2);
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

export type GetMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

export type GetMessageMSTeamsResult = {
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

export type PinMessageMSTeamsParams = {
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

export type UnpinMessageMSTeamsParams = {
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

export type ListPinsMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
};

export type ListPinsMSTeamsResult = {
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

export const TEAMS_REACTION_TYPES = [
  "like",
  "heart",
  "laugh",
  "surprised",
  "sad",
  "angry",
] as const;
export type TeamsReactionType = (typeof TEAMS_REACTION_TYPES)[number];

type GraphReaction = {
  reactionType?: string;
  user?: { id?: string; displayName?: string };
  createdDateTime?: string;
};

type GraphMessageWithReactions = GraphMessage & {
  reactions?: GraphReaction[];
};

export type ReactMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
  reactionType: string;
};

export type ListReactionsMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  messageId: string;
};

/** Map well-known reaction type names to representative emoji for CLI display. */
const REACTION_TYPE_EMOJI: Record<string, string> = {
  like: "\u{1F44D}",
  heart: "\u2764\uFE0F",
  laugh: "\u{1F606}",
  surprised: "\u{1F62E}",
  sad: "\u{1F622}",
  angry: "\u{1F621}",
};

export type ReactionSummary = {
  reactionType: string;
  /** Display name for the reaction (matches reactionType for known types). */
  name: string;
  /** Emoji representation when available. */
  emoji?: string;
  count: number;
  users: Array<{ id: string; displayName?: string }>;
};

export type ListReactionsMSTeamsResult = {
  reactions: ReactionSummary[];
};

/**
 * Normalize a reaction type string. Graph setReaction/unsetReaction accepts
 * the well-known legacy names (like, heart, laugh, surprised, sad, angry)
 * as well as Unicode emoji values — so we pass unknown types through rather
 * than rejecting them.
 */
function normalizeReactionType(raw: string): string {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error(`Reaction type is required. Common types: ${TEAMS_REACTION_TYPES.join(", ")}`);
  }
  // Lowercase only the well-known names; Unicode emoji should pass through as-is
  const lowered = normalized.toLowerCase();
  if (TEAMS_REACTION_TYPES.includes(lowered as TeamsReactionType)) {
    return lowered;
  }
  return normalized;
}

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
  const reactionType = normalizeReactionType(params.reactionType);
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
  const reactionType = normalizeReactionType(params.reactionType);
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
    emoji: REACTION_TYPE_EMOJI[type],
    count: group.count,
    users: group.users,
  }));

  return { reactions };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchMessagesMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  query: string;
  from?: string;
  limit?: number;
};

export type SearchMessagesMSTeamsResult = {
  messages: Array<{
    id: string;
    text: string | undefined;
    from: GraphMessageFrom | undefined;
    createdAt: string | undefined;
  }>;
};

const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 50;

/**
 * Search messages in a chat or channel by content via Graph API.
 * Uses `$search` for full-text body search and optional `$filter` for sender.
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

  // Strip double quotes from the query to prevent OData $search injection
  const sanitizedQuery = params.query.replace(/"/g, "");

  // Build query string manually (not URLSearchParams) to preserve literal $
  // in OData parameter names, consistent with other Graph calls in this module.
  const parts = [`$search=${encodeURIComponent(`"${sanitizedQuery}"`)}`];
  parts.push(`$top=${top}`);
  if (params.from) {
    parts.push(
      `$filter=${encodeURIComponent(`from/user/displayName eq '${escapeOData(params.from)}'`)}`,
    );
  }

  const path = `${basePath}/messages?${parts.join("&")}`;
  // ConsistencyLevel: eventual is required by Graph API for $search queries
  const res = await fetchGraphJson<GraphResponse<GraphMessage>>({
    token,
    path,
    headers: { ConsistencyLevel: "eventual" },
  });

  const messages = (res.value ?? []).map((msg) => ({
    id: msg.id ?? "",
    text: msg.body?.content,
    from: msg.from,
    createdAt: msg.createdDateTime,
  }));

  return { messages };
}
