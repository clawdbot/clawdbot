// Slack plugin module implements outbound adapter behavior.
import type { OutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  normalizeMessagePresentation,
  resolveLegacyInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveSlackAuthoredTextPlacement,
  type SlackAuthoredTextPlacement,
} from "./authored-text.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "./interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { SLACK_PRESENTATION_CAPABILITIES } from "./presentation.js";
import {
  parseSlackReplyBlockSegments,
  resolveSlackReplyBlockResolution,
  resolveSlackReplyDeliveryMessages,
  type SlackReplyBlockResolution,
  type SlackReplyBlockSegment,
} from "./reply-blocks.js";
import type { SlackSendIdentity } from "./send.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";

type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

type SlackOutboundChannelData = Record<string, unknown> & {
  authoredTextPlacement?: SlackAuthoredTextPlacement;
  blocks?: unknown;
  renderedPresentationProvenance?: unknown;
  renderedPresentationSegments?: SlackReplyBlockSegment[];
};

// Only renderPresentation can mint this identity. Direct channelData must not
// turn private ordered segments into arbitrary platform-send fanout.
const SLACK_RENDERED_PRESENTATION_PROVENANCE = Object.freeze({});

const loadSlackSendRuntime = createLazyRuntimeModule(() => import("./send.runtime.js"));

function resolveSlackSendIdentity(identity?: OutboundIdentity): SlackSendIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const username = normalizeOptionalString(identity.name);
  const iconUrl = normalizeOptionalString(identity.avatarUrl);
  const rawEmoji = normalizeOptionalString(identity.emoji);
  // Live Slack accepts Unicode custom icons even though its docs show shortcode form.
  // send.ts downgrades once per send when a workspace rejects the configured icon.
  const iconEmoji = !iconUrl ? rawEmoji : undefined;
  if (!username && !iconUrl && !iconEmoji) {
    return undefined;
  }
  return { username, iconUrl, iconEmoji };
}

function resolveSlackOutboundBlockResolution(payload: ReplyPayload): SlackReplyBlockResolution {
  const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
  const presentation = normalizeMessagePresentation(payload.presentation);
  const hasStructuredContent = Boolean(
    slackData?.blocks !== undefined || presentation || payload.interactive?.blocks.length,
  );
  if (!hasStructuredContent) {
    return {
      authoredTextPlacement: resolveSlackAuthoredTextPlacement(payload),
      segments: [],
    };
  }

  const {
    authoredTextPlacement: _authoredTextPlacement,
    renderedPresentationProvenance: _renderedPresentationProvenance,
    renderedPresentationSegments: _renderedPresentationSegments,
    ...preservedSlackData
  } = slackData ?? {};
  return resolveSlackReplyBlockResolution(
    {
      ...payload,
      channelData: {
        ...payload.channelData,
        slack: preservedSlackData,
      },
    },
    { materializeAuthoredText: true },
  );
}

function withSlackRenderedPresentation(
  payload: ReplyPayload,
  slackData: SlackOutboundChannelData | undefined,
  resolution: SlackReplyBlockResolution,
): ReplyPayload {
  const {
    authoredTextPlacement: _authoredTextPlacement,
    blocks: _blocks,
    renderedPresentationProvenance: _renderedPresentationProvenance,
    renderedPresentationSegments: _renderedPresentationSegments,
    ...preservedSlackData
  } = slackData ?? {};
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      slack: {
        ...preservedSlackData,
        authoredTextPlacement: resolution.authoredTextPlacement,
        renderedPresentationProvenance: SLACK_RENDERED_PRESENTATION_PROVENANCE,
        renderedPresentationSegments: resolution.segments,
      },
    },
  };
}

function readSlackAuthoredTextPlacement(value: unknown): SlackAuthoredTextPlacement | undefined {
  return value === "none" || value === "blocks" || value === "outside-blocks" ? value : undefined;
}

async function sendSlackOutboundMessage(params: {
  cfg: NonNullable<NonNullable<Parameters<SlackSendFn>[2]>["cfg"]>;
  to: string;
  text: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  blocks?: NonNullable<Parameters<SlackSendFn>[2]>["blocks"];
  authoredTextPlacement?: SlackAuthoredTextPlacement;
  nativeDataFallbackBaseText?: string;
  textIsSlackPlainText?: boolean;
  accountId?: string | null;
  deps?: { [channelId: string]: unknown } | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deliveryQueueId?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["deliveryQueueId"];
  onPlatformSendDispatch?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onPlatformSendDispatch"];
  onDeliveryResult?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendText"]>
  >[0]["onDeliveryResult"];
}) {
  const send =
    resolveOutboundSendDep<SlackSendFn>(params.deps, "slack") ??
    (await loadSlackSendRuntime()).sendMessageSlack;
  const slackIdentity = resolveSlackSendIdentity(params.identity);
  const threadTs = resolveSlackThreadTsValue({
    replyToId: params.replyToId,
    threadId: params.threadId,
  });
  const sendOptions: NonNullable<Parameters<SlackSendFn>[2]> & {
    authoredTextPlacement?: SlackAuthoredTextPlacement;
  } = {
    cfg: params.cfg,
    threadTs,
    accountId: params.accountId ?? undefined,
    ...(params.mediaUrl
      ? {
          mediaUrl: params.mediaUrl,
          mediaAccess: params.mediaAccess,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
        }
      : {}),
    ...(params.blocks ? { blocks: params.blocks } : {}),
    ...(params.authoredTextPlacement
      ? { authoredTextPlacement: params.authoredTextPlacement }
      : {}),
    ...(Object.hasOwn(params, "nativeDataFallbackBaseText")
      ? { nativeDataFallbackBaseText: params.nativeDataFallbackBaseText }
      : {}),
    ...(params.textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
    ...(slackIdentity ? { identity: slackIdentity } : {}),
    ...(params.deliveryQueueId ? { deliveryQueueId: params.deliveryQueueId } : {}),
    ...(params.onPlatformSendDispatch
      ? { onPlatformSendDispatch: params.onPlatformSendDispatch }
      : {}),
    ...(params.onDeliveryResult
      ? {
          onDeliveryResult: async (progress) => {
            await params.onDeliveryResult?.(attachChannelToResult("slack", progress));
          },
        }
      : {}),
  };
  const result = await send(params.to, params.text, sendOptions);
  return result;
}

function createSlackAttachedSendAdapter() {
  return createAttachedChannelResultAdapter({
    channel: "slack",
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
      deliveryQueueId,
      onPlatformSendDispatch,
      onDeliveryResult,
    }) =>
      await sendSlackOutboundMessage({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        threadId,
        identity,
        deliveryQueueId,
        onPlatformSendDispatch,
        onDeliveryResult,
      }),
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      identity,
      deliveryQueueId,
      onPlatformSendDispatch,
      onDeliveryResult,
    }) =>
      await sendSlackOutboundMessage({
        cfg,
        to,
        text,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        accountId,
        deps,
        replyToId,
        threadId,
        identity,
        deliveryQueueId,
        onPlatformSendDispatch,
        onDeliveryResult,
      }),
  });
}

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: SLACK_TEXT_LIMIT,
  normalizePayload: ({ payload, cfg, accountId }) =>
    isSlackInteractiveRepliesEnabled({ cfg, accountId })
      ? compileSlackInteractiveReplies(payload)
      : payload,
  presentationCapabilities: SLACK_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, ctx }) => {
    const payloadForBudget = isSlackInteractiveRepliesEnabled({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
    })
      ? compileSlackInteractiveReplies(payload)
      : payload;
    const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
    const resolution = resolveSlackOutboundBlockResolution(payloadForBudget);
    return resolution.segments.length > 0
      ? withSlackRenderedPresentation(payloadForBudget, slackData, resolution)
      : null;
  },
  sendPayload: async (ctx) => {
    const payload = {
      ...ctx.payload,
      text:
        resolveLegacyInteractiveTextFallback({
          text: ctx.payload.text,
          interactive: ctx.payload.interactive,
        }) ?? "",
    };
    const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
    const hasRenderedPresentationProvenance =
      slackData?.renderedPresentationProvenance === SLACK_RENDERED_PRESENTATION_PROVENANCE;
    const renderedSegments = hasRenderedPresentationProvenance
      ? parseSlackReplyBlockSegments(slackData?.renderedPresentationSegments)
      : undefined;
    const renderedPlacement = hasRenderedPresentationProvenance
      ? readSlackAuthoredTextPlacement(slackData?.authoredTextPlacement)
      : undefined;
    let resolution: SlackReplyBlockResolution;
    if (renderedSegments) {
      if (!renderedPlacement) {
        throw new Error("Slack rendered presentation is missing authored text placement");
      }
      resolution = { authoredTextPlacement: renderedPlacement, segments: renderedSegments };
    } else {
      resolution = resolveSlackOutboundBlockResolution(payload);
    }
    if (resolution.segments.length === 0) {
      return await sendTextMediaPayload({
        channel: "slack",
        ctx: { ...ctx, payload },
        adapter: slackOutbound,
      });
    }
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const deliveryMessages = resolveSlackReplyDeliveryMessages({
      authoredTextPlacement: resolution.authoredTextPlacement,
      segments: resolution.segments,
      text: payload.text,
    });
    const useSingleDeliveryMarker = mediaUrls.length === 0 && deliveryMessages.length === 1;
    return attachChannelToResult(
      "slack",
      await sendPayloadMediaSequenceAndFinalize({
        text: "",
        mediaUrls,
        send: async ({ text, mediaUrl }) =>
          await sendSlackOutboundMessage({
            cfg: ctx.cfg,
            to: ctx.to,
            text,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            accountId: ctx.accountId,
            deps: ctx.deps,
            replyToId: ctx.replyToId,
            threadId: ctx.threadId,
            identity: ctx.identity,
            deliveryQueueId: useSingleDeliveryMarker ? ctx.deliveryQueueId : undefined,
            onPlatformSendDispatch: useSingleDeliveryMarker
              ? ctx.onPlatformSendDispatch
              : undefined,
            onDeliveryResult: ctx.onDeliveryResult,
          }),
        finalize: async () => {
          let lastResult: Awaited<ReturnType<SlackSendFn>> | undefined;
          for (const message of deliveryMessages) {
            lastResult = await sendSlackOutboundMessage({
              cfg: ctx.cfg,
              to: ctx.to,
              text: message.text,
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
              ...(message.blocks ? { blocks: message.blocks } : {}),
              ...(message.authoredTextPlacement
                ? { authoredTextPlacement: message.authoredTextPlacement }
                : {}),
              ...(message.nativeDataFallbackBaseText
                ? { nativeDataFallbackBaseText: message.nativeDataFallbackBaseText }
                : {}),
              ...(message.textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
              accountId: ctx.accountId,
              deps: ctx.deps,
              replyToId: ctx.replyToId,
              threadId: ctx.threadId,
              identity: ctx.identity,
              deliveryQueueId: useSingleDeliveryMarker ? ctx.deliveryQueueId : undefined,
              onPlatformSendDispatch: useSingleDeliveryMarker
                ? ctx.onPlatformSendDispatch
                : undefined,
              onDeliveryResult: ctx.onDeliveryResult,
            });
          }
          if (!lastResult) {
            throw new Error("Slack rendered presentation produced no deliverable segment");
          }
          return lastResult;
        },
      }),
    );
  },
  afterDeliverPayload: async ({ cfg, target, payload, results }) => {
    const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
    const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
    if (
      !questionId ||
      slackData?.renderedPresentationProvenance !== SLACK_RENDERED_PRESENTATION_PROVENANCE
    ) {
      return;
    }
    const segments = parseSlackReplyBlockSegments(slackData.renderedPresentationSegments);
    const placement = readSlackAuthoredTextPlacement(slackData.authoredTextPlacement);
    if (!segments || !placement) {
      return;
    }
    const deliveryMessages = resolveSlackReplyDeliveryMessages({
      authoredTextPlacement: placement,
      segments,
      text: payload.text,
    });
    const blockMessageIndex = deliveryMessages.findIndex((message) =>
      message.blocks?.some((block) => block.type === "actions"),
    );
    const deliveryMessage = deliveryMessages[blockMessageIndex];
    const result =
      results[blockMessageIndex] ?? results.find((candidate) => candidate.channel === "slack");
    const deliveryBlocks = deliveryMessage?.blocks;
    if (!deliveryMessage || !deliveryBlocks || !result?.messageId) {
      return;
    }
    const channelId = result.channelId;
    if (!channelId) {
      return;
    }
    questionGatewayRuntime.registerChannelDelivery({
      questionId,
      deliveryId: `slack:${target.accountId ?? "default"}:${channelId}:${result.messageId}`,
      finalize: async (statusLine) => {
        const { updateMessageSlack } = await loadSlackSendRuntime();
        const escapedStatusLine = escapeSlackMrkdwn(statusLine);
        const blocks = [
          ...deliveryBlocks.filter((block) => block.type !== "actions"),
          { type: "context", elements: [{ type: "mrkdwn", text: escapedStatusLine }] },
        ];
        await updateMessageSlack({
          cfg,
          accountId: target.accountId ?? undefined,
          channelId,
          messageTs: result.messageId,
          text: `${deliveryMessage.text}\n\n${escapedStatusLine}`,
          blocks,
        });
      },
    });
  },
  ...createSlackAttachedSendAdapter(),
};
