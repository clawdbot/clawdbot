// Mattermost maps transport mention facts into the shared channel evaluator.
import {
  resolveInboundMentionDecision,
  type InboundImplicitMentionKind,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelImplicitMentions } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MattermostPost } from "./client.js";
import type { ChatType, OpenClawConfig } from "./runtime-api.js";

export function resolveMattermostInboundMentionDecision(params: {
  cfg: OpenClawConfig;
  accountId: string;
  kind: ChatType;
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}) {
  const implicitMentions = resolveChannelImplicitMentions({
    cfg: params.cfg,
    channel: "mattermost",
    accountId: params.accountId,
  });
  return resolveInboundMentionDecision({
    facts: {
      canDetectMention: params.canDetectMention,
      wasMentioned: params.wasMentioned,
      implicitMentionKinds: params.implicitMentionKinds,
    },
    policy: {
      isGroup: params.kind !== "direct",
      requireMention: params.requireMention,
      implicitMentions,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });
}

/**
 * Produces the `reply_to_bot` implicit-mention fact for Mattermost. Threads are flat: a reply
 * carries only `root_id` (the thread root), so "replying to the bot" means the bot authored that
 * root. The `posted` websocket payload omits the root author, so the caller injects a (cached)
 * fetcher; no thread root means no reply-to-bot. Policy (`implicitMentions.replyToBot`) stays with
 * the shared evaluator — this only reports the fact.
 */
export async function resolveMattermostReplyToBot(params: {
  threadRootId?: string;
  botUserId: string;
  fetchRootPost: (postId: string) => Promise<MattermostPost | null>;
}): Promise<boolean> {
  const rootPostId = normalizeOptionalString(params.threadRootId);
  if (!rootPostId) {
    return false;
  }
  const rootPost = await params.fetchRootPost(rootPostId);
  return normalizeOptionalString(rootPost?.user_id) === params.botUserId;
}
