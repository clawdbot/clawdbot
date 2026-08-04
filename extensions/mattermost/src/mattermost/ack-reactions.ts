// Mattermost plugin module implements automatic ack reactions for accepted posts.
import { resolveAckReaction } from "openclaw/plugin-sdk/agent-runtime";
import { createAckReactionHandle, shouldAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MattermostClient } from "./client.js";
import { createMattermostReactionMutation } from "./reactions.js";

const MATTERMOST_EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_+-]{1,64}$/;
const MATTERMOST_EMOJI_NAME_BY_GLYPH: Readonly<Record<string, string>> = Object.freeze({
  "👀": "eyes",
  "👍": "+1",
  "👎": "-1",
  "✅": "white_check_mark",
  "❤": "heart",
  "🎉": "tada",
  "🔥": "fire",
  "👏": "clap",
  "🚀": "rocket",
});

export type MattermostAckReactionGateFacts = {
  isDirect: boolean;
  isGroup: boolean;
  canDetectMention: boolean;
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
};

/** Mattermost reaction endpoints accept emoji names, not raw Unicode glyphs. */
function resolveMattermostReactionEmojiName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const candidate =
    trimmed.length > 2 && trimmed.startsWith(":") && trimmed.endsWith(":")
      ? trimmed.slice(1, -1)
      : trimmed;
  const withoutVariationSelector = candidate.replace(/[\uFE0E\uFE0F]/g, "");
  return (
    MATTERMOST_EMOJI_NAME_BY_GLYPH[withoutVariationSelector] ??
    (MATTERMOST_EMOJI_NAME_PATTERN.test(candidate) ? candidate : null)
  );
}

/** Queues the shared ack policy only after the inbound post has been durably recorded. */
export function createMattermostAckReactionRuntime(params: {
  cfg: OpenClawConfig;
  client: MattermostClient;
  botUserId: string;
  agentId: string;
  accountId: string;
  postId: string;
  gate: MattermostAckReactionGateFacts;
  log: (message: string) => void;
}) {
  const configuredReaction = resolveAckReaction(params.cfg, params.agentId, {
    channel: "mattermost",
    accountId: params.accountId,
  });
  const reactionName = configuredReaction
    ? resolveMattermostReactionEmojiName(configuredReaction)
    : null;
  const shouldSend = Boolean(
    reactionName &&
    shouldAckReaction({
      scope: params.cfg.messages?.ackReactionScope,
      isDirect: params.gate.isDirect,
      isGroup: params.gate.isGroup,
      isMentionableGroup: params.gate.isGroup,
      canDetectMention: params.gate.canDetectMention,
      effectiveWasMentioned: params.gate.effectiveWasMentioned,
      shouldBypassMention: params.gate.shouldBypassMention,
    }),
  );
  let queued = false;

  return {
    queueAfterRecord: () => {
      if (queued || !shouldSend || !reactionName) {
        return;
      }
      queued = true;
      createAckReactionHandle({
        ackReactionValue: reactionName,
        send: () =>
          createMattermostReactionMutation(params.client, {
            userId: params.botUserId,
            postId: params.postId,
            emojiName: reactionName,
          }),
        remove: async () => {},
        onSendError: (err) => {
          params.log(`mattermost ack reaction failed post=${params.postId}: ${String(err)}`);
        },
      });
    },
  };
}
