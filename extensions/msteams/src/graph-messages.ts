// Msteams plugin module implements graph messages behavior.
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveConversationPath, resolveGraphConversationId } from "./graph-conversation-path.js";
import {
  deleteGraphRequest,
  fetchGraphAbsoluteUrl,
  fetchGraphJson,
  mutateGraphJson,
  resolveGraphToken,
} from "./graph.js";
import { getMSTeamsReactionEmoji, resolveMSTeamsReactionEmoji } from "./reaction-types.js";

export { resolveConversationPath, resolveGraphConversationId } from "./graph-conversation-path.js";
export { searchMessagesMSTeams } from "./graph-message-search.js";

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
type GetMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
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
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
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
  accountId?: string | null;
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
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
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
  const result = await mutateGraphJson<{ id?: string }>({
    token,
    path: `${conv.basePath}/pinnedMessages`,
    method: "POST",
    body,
  });
  return { ok: true, pinnedMessageId: result.id };
}

type UnpinMessageMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
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
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
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
  accountId?: string | null;
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
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
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
  accountId?: string | null;
  to: string;
  messageId: string;
  reactionType: string;
};

type ListReactionsMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
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
  const token = await resolveGraphToken(params.cfg, {
    accountId: params.accountId,
    preferDelegated: true,
  });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/setReaction`;
  await mutateGraphJson<unknown>({
    token,
    path,
    method: "POST",
    body: { reactionType },
    beta: true,
  });
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
  const token = await resolveGraphToken(params.cfg, {
    accountId: params.accountId,
    preferDelegated: true,
  });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const { basePath } = resolveConversationPath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(params.messageId)}/unsetReaction`;
  await mutateGraphJson<unknown>({
    token,
    path,
    method: "POST",
    body: { reactionType },
    beta: true,
  });
  return { ok: true };
}

/**
 * List reactions on a message, grouped by type.
 * Uses Graph v1.0 (reactions are included in the message resource).
 */
export async function listReactionsMSTeams(
  params: ListReactionsMSTeamsParams,
): Promise<ListReactionsMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
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
