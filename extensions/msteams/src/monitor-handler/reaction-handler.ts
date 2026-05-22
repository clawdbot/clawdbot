import { normalizeMSTeamsConversationId } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { resolveMSTeamsSenderAccess } from "./access.js";

/** Teams reaction type names → Unicode emoji. */
const TEAMS_REACTION_EMOJI: Record<string, string> = {
  like: "👍",
  heart: "❤️",
  laugh: "😆",
  surprised: "😮",
  sad: "😢",
  angry: "😡",
};

/**
 * Map a Teams reaction type string to a Unicode emoji.
 * Falls back to the raw type if not recognized.
 */
function mapReactionEmoji(reactionType: string): string {
  return TEAMS_REACTION_EMOJI[reactionType] ?? reactionType;
}

type ReactionDirection = "added" | "removed";

/**
 * Create a handler for MS Teams reaction activities (reactionsAdded / reactionsRemoved).
 * The returned function accepts a turn context and a direction string.
 */
export function createMSTeamsReactionHandler(deps: MSTeamsMessageHandlerDeps) {
  const { cfg, log } = deps;
  const core = getMSTeamsRuntime();
  const msteamsCfg = cfg.channels?.msteams;

  return async function handleReaction(
    context: MSTeamsTurnContext,
    direction: ReactionDirection,
  ): Promise<void> {
    const activity = context.activity;

    // Reactions are carried in reactionsAdded / reactionsRemoved on the activity.
    const reactions: Array<{ type?: string }> =
      direction === "added"
        ? ((activity as unknown as { reactionsAdded?: Array<{ type?: string }> }).reactionsAdded ??
          [])
        : ((activity as unknown as { reactionsRemoved?: Array<{ type?: string }> })
            .reactionsRemoved ?? []);

    if (reactions.length === 0) {
      log.debug?.("reaction activity has no reactions; skipping");
      return;
    }

    const from = activity.from;
    if (!from?.id) {
      log.debug?.("reaction activity missing from.id; skipping");
      return;
    }

    const rawConversationId = activity.conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationType = activity.conversation?.conversationType ?? "personal";
    const isGroupChat = conversationType === "groupChat" || activity.conversation?.isGroup === true;
    const isChannel = conversationType === "channel";
    const isDirectMessage = !isGroupChat && !isChannel;

    const senderId = from.aadObjectId ?? from.id;
    const senderName = from.name ?? from.id;

    if (msteamsCfg) {
      const senderAccess = await resolveMSTeamsSenderAccess({ cfg, activity });
      if (senderAccess.senderAccess.decision !== "allow") {
        log.debug?.("dropping reaction (access denied)", {
          sender: senderId,
          reason: senderAccess.senderAccess.reasonCode,
        });
        return;
      }
    }

    // Resolve the agent route for this conversation/sender.
    // Extract teamId for team-scoped routing bindings (channel/group reactions).
    const teamId = isDirectMessage
      ? undefined
      : (activity as unknown as { channelData?: { team?: { id?: string } } }).channelData?.team?.id;
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "msteams",
      peer: {
        kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
        id: isDirectMessage ? senderId : conversationId,
      },
      ...(teamId ? { teamId } : {}),
    });

    // The replyToId points to the message that was reacted to.
    const targetMessageId = (activity as unknown as { replyToId?: string }).replyToId ?? "unknown";

    for (const reaction of reactions) {
      const reactionType = reaction.type ?? "unknown";
      const emoji = mapReactionEmoji(reactionType);
      const label =
        direction === "added"
          ? `Teams reaction ${emoji} added by ${senderName} on message ${targetMessageId}`
          : `Teams reaction ${emoji} removed by ${senderName} from message ${targetMessageId}`;

      log.info(`reaction ${direction}`, {
        sender: senderId,
        reactionType,
        emoji,
        targetMessageId,
        conversationId,
      });

      core.system.enqueueSystemEvent(label, {
        sessionKey: route.sessionKey,
        contextKey: `msteams:reaction:${conversationId}:${targetMessageId}:${senderId}:${reactionType}:${direction}`,
      });
    }
  };
}
