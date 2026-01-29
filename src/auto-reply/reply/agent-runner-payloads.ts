import type { ReplyToMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { formatBunFetchSocketError, isBunFetchSocketError } from "./agent-runner-utils.js";
import { createBlockReplyPayloadKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import { parseReplyDirectives } from "./reply-directives.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  isRenderablePayload,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";

export function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  directlySentBlockKeys?: Set<string>;
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentTargets?: Parameters<
    typeof shouldSuppressMessagingToolReplies
  >[0]["messagingToolSentTargets"];
  originatingTo?: string;
  originatingThreadId?: string | number;
  accountId?: string;
}): { replyPayloads: ReplyPayload[]; didLogHeartbeatStrip: boolean } {
  let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
  const sanitizedPayloads = params.isHeartbeat
    ? params.payloads
    : params.payloads.flatMap((payload) => {
        let text = payload.text;

        if (payload.isError && text && isBunFetchSocketError(text)) {
          text = formatBunFetchSocketError(text);
        }

        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [{ ...payload, text }];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        if (stripped.didStrip && !didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from reply");
        }
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) return [];
        return [{ ...payload, text: stripped.text }];
      });

  const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
    payloads: sanitizedPayloads,
    replyToMode: params.replyToMode,
    replyToChannel: params.replyToChannel,
    currentMessageId: params.currentMessageId,
  })
    .map((payload) => {
      const parsed = parseReplyDirectives(payload.text ?? "", {
        currentMessageId: params.currentMessageId,
        silentToken: SILENT_REPLY_TOKEN,
      });
      const mediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
      const mediaUrl = payload.mediaUrl ?? parsed.mediaUrl ?? mediaUrls?.[0];
      return {
        ...payload,
        text: parsed.text ? parsed.text : undefined,
        mediaUrls,
        mediaUrl,
        replyToId: payload.replyToId ?? parsed.replyToId,
        replyToTag: payload.replyToTag || parsed.replyToTag,
        replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
        audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
      };
    })
    .filter(isRenderablePayload);

  // Drop final payloads only when block streaming succeeded end-to-end.
  // If streaming aborted (e.g., timeout), fall back to final payloads.
  const shouldDropFinalPayloads =
    params.blockStreamingEnabled &&
    Boolean(params.blockReplyPipeline?.didStream()) &&
    !params.blockReplyPipeline?.isAborted();
  const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
  const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
  const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
    messageProvider: params.messageProvider,
    messagingToolSentTargets,
    originatingTo: params.originatingTo,
    originatingThreadId: params.originatingThreadId,
    accountId: params.accountId,
    replyToMode: params.replyToMode,
  });
  const dedupedPayloads = filterMessagingToolDuplicates({
    payloads: replyTaggedPayloads,
    sentTexts: messagingToolSentTexts,
  });
  // Filter out payloads already sent via pipeline or directly during tool flush.
  const filteredPayloads = shouldDropFinalPayloads
    ? []
    : params.blockStreamingEnabled
      ? dedupedPayloads.filter((payload) => !params.blockReplyPipeline?.hasSentPayload(payload))
      : params.directlySentBlockKeys?.size
        ? dedupedPayloads.filter(
            (payload) => !params.directlySentBlockKeys!.has(createBlockReplyPayloadKey(payload)),
          )
        : dedupedPayloads;
  const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

  return {
    replyPayloads,
    didLogHeartbeatStrip,
  };
}
