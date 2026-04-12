import type { OpenClawConfig } from "../runtime-api.js";
import { fetchGraphJson, postGraphJson, resolveGraphToken } from "./graph.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import { getMSTeamsRuntime } from "./runtime.js";

/** Teams native reaction type names. */
const UNICODE_TO_TEAMS_REACTION: Record<string, string> = {
  "👍": "like",
  "❤️": "heart",
  "😆": "laugh",
  "😮": "surprised",
  "😢": "sad",
  "😡": "angry",
};

/**
 * Map a Unicode emoji or Teams reaction name to the Teams API reaction type.
 * Falls back to the original value if not recognized.
 */
function resolveTeamsReactionType(emoji: string): string {
  const trimmed = emoji.trim();
  // If it's already a Teams native type, use it directly.
  if (/^(like|heart|laugh|surprised|sad|angry)$/.test(trimmed)) {
    return trimmed;
  }
  return UNICODE_TO_TEAMS_REACTION[trimmed] ?? trimmed;
}

/**
 * Detect whether this is a Graph-compatible chat/channel ID.
 * Bot Framework personal DM IDs (a:xxx / 8:orgid:xxx) cannot be used with Graph
 * /chats endpoints; only 19:xxx@thread.* IDs are valid there.
 */
function isGraphCompatibleConversationId(conversationId: string): boolean {
  return conversationId.startsWith("19:") || conversationId.includes("@thread");
}

export type ReactMessageMSTeamsParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to address */
  to: string;
  /** Activity/message ID to react to */
  activityId: string;
  /** Emoji or Teams reaction type (like, heart, laugh, surprised, sad, angry) */
  emoji: string;
};

export type ReactMessageMSTeamsResult = {
  ok: true;
};

/**
 * Add a reaction to an MS Teams message via the Graph API.
 *
 * MS Teams Bot Framework does not expose a "send reaction" verb; outbound reactions
 * must go through the Graph API `/chats/{chatId}/messages/{messageId}/setReaction`.
 * This requires the `ChatMessage.Send` or `Chat.ReadWrite` **Delegated** permission.
 *
 * LIMITATION: `setReaction`/`unsetReaction` only supports Delegated permissions.
 * The bot currently uses Application credentials, so outbound reactions will not work
 * until delegated-auth support is implemented. The code is kept here for future use.
 *
 * Note: Only conversations with Graph-compatible IDs (19:xxx@thread.*) are supported.
 * Personal DM conversations with Bot Framework IDs (a:xxx) cannot use this endpoint
 * without first resolving the Graph chat ID, which is not cached here.
 */
export async function reactMessageMSTeams(
  params: ReactMessageMSTeamsParams,
): Promise<ReactMessageMSTeamsResult> {
  const { cfg, to, activityId, emoji } = params;
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:react" });

  // Strip conversation: prefix if present — Graph API uses the bare chat ID.
  const rawTo = to.trim().replace(/^conversation:/, "");
  const conversationId = normalizeMSTeamsConversationId(rawTo);
  if (!isGraphCompatibleConversationId(conversationId)) {
    log.warn?.(
      "MS Teams reactions via Graph API require a 19:xxx@thread conversation ID; " +
        "Bot Framework personal DM IDs are not supported",
      { conversationId },
    );
    throw new Error(
      `MS Teams reaction requires a Graph-compatible conversation ID (got: ${conversationId}). ` +
        "Personal DM conversations must be addressed via their 19:xxx@thread.* chat ID.",
    );
  }

  const reactionType = resolveTeamsReactionType(emoji);
  const token = await resolveGraphToken(cfg, { preferDelegated: true });

  // POST /chats/{chatId}/messages/{messageId}/setReaction
  const path = `/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(activityId)}/setReaction`;
  await postGraphJson<unknown>({
    token,
    path,
    body: { reactionType },
  });

  log.debug?.("reaction added", { conversationId, activityId, reactionType });
  return { ok: true };
}

export type RemoveReactionMSTeamsParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID or user ID to address */
  to: string;
  /** Activity/message ID to remove reaction from */
  activityId: string;
  /** Emoji or Teams reaction type to remove */
  emoji: string;
};

/**
 * Remove a reaction from an MS Teams message via the Graph API.
 *
 * Uses POST /chats/{chatId}/messages/{messageId}/unsetReaction with body {"reactionType": "..."}.
 * Requires Delegated permissions (delegatedAuth must be enabled in config).
 */
export async function removeReactionMSTeams(
  params: RemoveReactionMSTeamsParams,
): Promise<ReactMessageMSTeamsResult> {
  const { cfg, to, activityId, emoji } = params;
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:react" });

  // Strip conversation: prefix if present — Graph API uses the bare chat ID.
  const rawTo = to.trim().replace(/^conversation:/, "");
  const conversationId = normalizeMSTeamsConversationId(rawTo);
  if (!isGraphCompatibleConversationId(conversationId)) {
    log.warn?.("MS Teams reactions via Graph API require a 19:xxx@thread conversation ID", {
      conversationId,
    });
    throw new Error(
      `MS Teams reaction requires a Graph-compatible conversation ID (got: ${conversationId}).`,
    );
  }

  const reactionType = resolveTeamsReactionType(emoji);
  const token = await resolveGraphToken(cfg, { preferDelegated: true });

  // POST /chats/{chatId}/messages/{messageId}/unsetReaction
  const path = `/chats/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(activityId)}/unsetReaction`;
  await postGraphJson<unknown>({
    token,
    path,
    body: { reactionType },
  });

  log.debug?.("reaction removed", { conversationId, activityId, reactionType });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// List reactions (read-only, works with Application auth)
// ---------------------------------------------------------------------------

type GraphReaction = {
  reactionType?: string;
  user?: { id?: string; displayName?: string };
  createdDateTime?: string;
};

type GraphMessageWithReactions = {
  reactions?: GraphReaction[];
};

export type ListReactionsMSTeamsParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID (19:xxx@thread.*) or teamId/channelId */
  to: string;
  /** Message ID to list reactions for */
  messageId: string;
};

export type ReactionSummary = {
  reactionType: string;
  count: number;
  users: Array<{ id: string; displayName?: string }>;
};

export type ListReactionsMSTeamsResult = {
  reactions: ReactionSummary[];
};

/**
 * Strip conversation: or user: prefix from a target string so the bare ID
 * can be used in Graph API paths.
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
 * Resolve the Graph API base path for a conversation target.
 * Supports both chat IDs (19:xxx) and teamId/channelId pairs.
 */
function resolveConversationBasePath(to: string): string {
  const cleaned = stripTargetPrefix(to);
  if (cleaned.includes("/")) {
    const [teamId, channelId] = cleaned.split("/", 2);
    return `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}`;
  }
  return `/chats/${encodeURIComponent(cleaned)}`;
}

/**
 * List reactions on a message, grouped by type.
 * Uses Graph v1.0 GET (reactions are included in the message resource).
 * This is a read-only operation that works with Application auth.
 */
export async function listReactionsMSTeams(
  params: ListReactionsMSTeamsParams,
): Promise<ListReactionsMSTeamsResult> {
  const { cfg, to, messageId } = params;
  const token = await resolveGraphToken(cfg);

  const rawTo = to.trim().replace(/^conversation:/i, "");
  const conversationId = normalizeMSTeamsConversationId(rawTo);
  if (!isGraphCompatibleConversationId(conversationId) && !conversationId.includes("/")) {
    throw new Error(
      `MS Teams list reactions requires a Graph-compatible conversation ID (got: ${conversationId}).`,
    );
  }

  const basePath = resolveConversationBasePath(conversationId);
  const path = `${basePath}/messages/${encodeURIComponent(messageId)}`;
  const msg = await fetchGraphJson<GraphMessageWithReactions>({ token, path });

  const grouped = new Map<string, Array<{ id: string; displayName?: string }>>();
  for (const reaction of msg.reactions ?? []) {
    const type = reaction.reactionType ?? "unknown";
    if (!grouped.has(type)) {
      grouped.set(type, []);
    }
    if (reaction.user?.id) {
      grouped.get(type)!.push({
        id: reaction.user.id,
        displayName: reaction.user.displayName,
      });
    }
  }

  const reactions: ReactionSummary[] = Array.from(grouped.entries()).map(([type, users]) => ({
    reactionType: type,
    count: users.length,
    users,
  }));

  return { reactions };
}
