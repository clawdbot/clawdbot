import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { MessagingToolSend } from "../../agents/pi-embedded-messaging.types.js";
import type { ReplyToMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
import { formatBunFetchSocketError, isBunFetchSocketError } from "./agent-runner-utils.js";
import { createBlockReplyContentKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import { applyReplyThreading, isRenderablePayload } from "./reply-payloads-base.js";

let replyPayloadsDedupeRuntimePromise: Promise<
  typeof import("./reply-payloads-dedupe.runtime.js")
> | null = null;

function loadReplyPayloadsDedupeRuntime() {
  replyPayloadsDedupeRuntimePromise ??= import("./reply-payloads-dedupe.runtime.js");
  return replyPayloadsDedupeRuntimePromise;
}

async function normalizeReplyPayloadMedia(params: {
  payload: ReplyPayload;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<ReplyPayload> {
  if (!params.normalizeMediaPaths || !resolveSendableOutboundReplyParts(params.payload).hasMedia) {
    return params.payload;
  }

  try {
    return await params.normalizeMediaPaths(params.payload);
  } catch (err) {
    logVerbose(`reply payload media normalization failed: ${String(err)}`);
    return {
      ...params.payload,
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    };
  }
}

async function normalizeSentMediaUrlsForDedupe(params: {
  sentMediaUrls: string[];
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<string[]> {
  if (params.sentMediaUrls.length === 0 || !params.normalizeMediaPaths) {
    return params.sentMediaUrls;
  }

  const normalizedUrls: string[] = [];
  const seen = new Set<string>();
  for (const raw of params.sentMediaUrls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalizedUrls.push(trimmed);
    }
    try {
      const normalized = await params.normalizeMediaPaths({
        mediaUrl: trimmed,
        mediaUrls: [trimmed],
      });
      const normalizedMediaUrls = resolveSendableOutboundReplyParts(normalized).mediaUrls;
      for (const mediaUrl of normalizedMediaUrls) {
        const candidate = mediaUrl.trim();
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        normalizedUrls.push(candidate);
      }
    } catch (err) {
      logVerbose(`messaging tool sent-media normalization failed: ${String(err)}`);
    }
  }

  return normalizedUrls;
}

export async function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  silentExpected?: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  directlySentBlockKeys?: Set<string>;
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  replyThreading?: ReplyThreadingPolicy;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: MessagingToolSend[];
  originatingChannel?: OriginatingChannelType;
  originatingTo?: string;
  accountId?: string;
  normalizeMediaPaths?: (payload: ReplyPayload) => Promise<ReplyPayload>;
}): Promise<{ replyPayloads: ReplyPayload[]; didLogHeartbeatStrip: boolean }> {
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
        const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });

  const replyTaggedPayloads = (
    await Promise.all(
      applyReplyThreading({
        payloads: sanitizedPayloads,
        replyToMode: params.replyToMode,
        replyToChannel: params.replyToChannel,
        currentMessageId: params.currentMessageId,
        replyThreading: params.replyThreading,
      }).map(async (payload) => {
        const parsed = normalizeReplyPayloadDirectives({
          payload,
          currentMessageId: params.currentMessageId,
          silentToken: SILENT_REPLY_TOKEN,
          parseMode: "always",
        }).payload;
        return await normalizeReplyPayloadMedia({
          payload: parsed,
          normalizeMediaPaths: params.normalizeMediaPaths,
        });
      }),
    )
  ).filter(isRenderablePayload);
  const silentFilteredPayloads = params.silentExpected ? [] : replyTaggedPayloads;

  // Drop final payloads only when block streaming succeeded end-to-end.
  // If streaming aborted (e.g., timeout), fall back to final payloads.
  const shouldDropFinalPayloads =
    params.blockStreamingEnabled &&
    Boolean(params.blockReplyPipeline?.didStream()) &&
    !params.blockReplyPipeline?.isAborted();
  const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
  const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
  const shouldCheckMessagingToolDedupe =
    messagingToolSentTexts.length > 0 ||
    (params.messagingToolSentMediaUrls?.length ?? 0) > 0 ||
    messagingToolSentTargets.length > 0;
  const dedupeRuntime = shouldCheckMessagingToolDedupe
    ? await loadReplyPayloadsDedupeRuntime()
    : null;
  const suppressMessagingToolReplies =
    dedupeRuntime?.shouldSuppressMessagingToolReplies({
      messageProvider: resolveOriginMessageProvider({
        originatingChannel: params.originatingChannel,
        provider: params.messageProvider,
      }),
      messagingToolSentTargets,
      originatingTo: resolveOriginMessageTo({
        originatingTo: params.originatingTo,
      }),
      accountId: resolveOriginAccountId({
        originatingAccountId: params.accountId,
      }),
    }) ?? false;
  // Only dedupe against messaging tool sends for the same origin target.
  // Cross-target sends (for example posting to another channel) must not
  // suppress the current conversation's final reply.
  // If target metadata is unavailable, keep legacy dedupe behavior.
  const dedupeMessagingToolPayloads =
    suppressMessagingToolReplies || messagingToolSentTargets.length === 0;
  const messagingToolSentMediaUrls = dedupeMessagingToolPayloads
    ? await normalizeSentMediaUrlsForDedupe({
        sentMediaUrls: params.messagingToolSentMediaUrls ?? [],
        normalizeMediaPaths: params.normalizeMediaPaths,
      })
    : (params.messagingToolSentMediaUrls ?? []);
  const dedupedPayloads = dedupeMessagingToolPayloads
    ? (dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())).filterMessagingToolDuplicates({
        payloads: silentFilteredPayloads,
        sentTexts: messagingToolSentTexts,
      })
    : silentFilteredPayloads;
  const mediaFilteredPayloads = dedupeMessagingToolPayloads
    ? (
        dedupeRuntime ?? (await loadReplyPayloadsDedupeRuntime())
      ).filterMessagingToolMediaDuplicates({
        payloads: dedupedPayloads,
        sentMediaUrls: messagingToolSentMediaUrls,
      })
    : dedupedPayloads;
  // Filter out payloads already sent via pipeline or directly during tool flush.
  const filteredPayloads = shouldDropFinalPayloads
    ? []
    : params.blockStreamingEnabled
      ? mediaFilteredPayloads.filter(
          (payload) => !params.blockReplyPipeline?.hasSentPayload(payload),
        )
      : params.directlySentBlockKeys?.size
        ? mediaFilteredPayloads.filter(
            (payload) => !params.directlySentBlockKeys!.has(createBlockReplyContentKey(payload)),
          )
        : mediaFilteredPayloads;
  const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

  return {
    replyPayloads,
    didLogHeartbeatStrip,
  };
}
