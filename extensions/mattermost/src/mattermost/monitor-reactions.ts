// Mattermost plugin module maps reaction transport events into system events.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostMonitorInboundAccess } from "./monitor-auth.js";
import { resolveMattermostReactionChannelId } from "./monitor-context.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";

type MattermostReaction = { user_id?: string; post_id?: string; emoji_name?: string };

export function createMattermostReactionHandler(monitor: MattermostMonitorContext) {
  const { account, botUserId, cfg, core, groupPolicy, pairing, resources } = monitor;
  const { resolveUserInfo } = resources;
  return async (payload: MattermostEventPayload) => {
    const reactionData = payload.data?.reaction;
    if (!reactionData) {
      return;
    }
    let reaction: MattermostReaction | null = null;
    if (typeof reactionData === "string") {
      try {
        reaction = JSON.parse(reactionData) as MattermostReaction;
      } catch {
        return;
      }
    } else if (typeof reactionData === "object") {
      reaction = reactionData as MattermostReaction;
    }
    const userId = reaction?.user_id?.trim();
    const postId = reaction?.post_id?.trim();
    const emojiName = reaction?.emoji_name?.trim();
    if (!userId || !postId || !emojiName || userId === botUserId) {
      return;
    }

    const action = payload.event === "reaction_removed" ? "removed" : "added";
    const senderName = normalizeOptionalString((await resolveUserInfo(userId))?.username) ?? userId;
    const channelId = resolveMattermostReactionChannelId(payload);
    if (!channelId) {
      // Without a channel id we cannot verify DM/group policies — drop to be safe.
      monitor.logVerboseMessage(
        "mattermost: drop reaction (no channel_id in broadcast, cannot enforce policy)",
      );
      return;
    }
    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId,
      senderId: userId,
      dropLabel: "reaction",
    });
    if (!eventPlan) {
      return;
    }
    const { kind, route } = eventPlan;
    const reactionAccess = await resolveMattermostMonitorInboundAccess({
      account,
      cfg,
      senderId: userId,
      senderName,
      channelId,
      kind,
      groupPolicy,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands: false,
      hasControlCommand: false,
      eventKind: "reaction",
      mayPair: false,
    });
    if (reactionAccess.ingress.decision !== "allow") {
      monitor.logVerboseMessage(
        kind === "direct"
          ? `mattermost: drop reaction (dmPolicy=${account.config.dmPolicy ?? "pairing"} sender=${userId} reason=${reactionAccess.senderAccess.reasonCode})`
          : `mattermost: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.senderAccess.reasonCode} channel=${channelId})`,
      );
      return;
    }

    const eventText = `Mattermost reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;
    core.system.enqueueSystemEvent(eventText, {
      sessionKey: route.sessionKey,
      contextKey: `mattermost:reaction:${postId}:${emojiName}:${userId}:${action}`,
    });
    monitor.logVerboseMessage(
      `mattermost reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`,
    );
  };
}
