// Slack plugin module implements outbound adapter behavior.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { SLACK_PRESENTATION_CAPABILITIES } from "./presentation.js";
import {
  resolveSlackQuestionActionIds,
  SLACK_QUESTION_FINALIZATION_BLOCKS,
} from "./reply-action-ids.js";
import {
  parseSlackReplyBlockSegments,
  resolveSlackReplyBlockResolution,
  resolveSlackReplyDeliveryMessages,
  type SlackReplyBlockResolution,
  type SlackReplyBlockSegment,
} from "./reply-blocks.js";
import type { SlackSendIdentity, SlackSendResult } from "./send.js";
import { parseSlackTarget } from "./target-parsing.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";

type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

function toSlackOutboundResult<T extends { channelId?: string }>(result: T) {
  const { channelId, ...delivery } = result;
  return channelId === undefined
    ? delivery
    : { ...delivery, target: { kind: "channel" as const, id: channelId } };
}

type SlackOutboundChannelData = Record<string, unknown> & {
  authoredTextPlacement?: SlackAuthoredTextPlacement;
  blocks?: unknown;
  renderedPresentationProvenance?: unknown;
  renderedPresentationSegments?: SlackReplyBlockSegment[];
};

// Rendered payloads may be cloned by outbound hooks. Sign the exact private
// delivery plan so it survives cloning without allowing a caller to alter or
// fan out channelData segments before sendPayload validates them.
const SLACK_RENDERED_PRESENTATION_PROVENANCE_KEY = randomBytes(32);

function createSlackRenderedPresentationProvenance(resolution: SlackReplyBlockResolution): string {
  return createHmac("sha256", SLACK_RENDERED_PRESENTATION_PROVENANCE_KEY)
    .update(JSON.stringify([resolution.authoredTextPlacement, resolution.segments]))
    .digest("base64url");
}

function hasValidSlackRenderedPresentationProvenance(params: {
  provenance: string;
  resolution: SlackReplyBlockResolution;
}): boolean {
  const expected = createSlackRenderedPresentationProvenance(params.resolution);
  const actualBuffer = Buffer.from(params.provenance);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function readSlackRenderedPresentation(
  slackData: SlackOutboundChannelData | undefined,
): SlackReplyBlockResolution | undefined {
  const provenance = slackData?.renderedPresentationProvenance;
  if (typeof provenance !== "string") {
    return undefined;
  }
  try {
    const segments = parseSlackReplyBlockSegments(slackData?.renderedPresentationSegments);
    const authoredTextPlacement = readSlackAuthoredTextPlacement(slackData?.authoredTextPlacement);
    if (!segments || !authoredTextPlacement) {
      return undefined;
    }
    const resolution = { authoredTextPlacement, segments };
    return hasValidSlackRenderedPresentationProvenance({ provenance, resolution })
      ? resolution
      : undefined;
  } catch {
    // Private renderer metadata is untrusted until its signature verifies.
    // Invalid caller-authored shapes must use the public fallback, not abort delivery.
    return undefined;
  }
}

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
        renderedPresentationProvenance: createSlackRenderedPresentationProvenance(resolution),
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
  forceDocument?: boolean;
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
          ...(params.forceDocument ? { forceDocument: true } : {}),
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
            await params.onDeliveryResult?.(
              attachChannelToResult("slack", toSlackOutboundResult(progress)),
            );
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
    sendText: async (ctx) => toSlackOutboundResult(await sendSlackOutboundMessage(ctx)),
    sendMedia: async (ctx) => toSlackOutboundResult(await sendSlackOutboundMessage(ctx)),
  });
}

export const slackOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: SLACK_TEXT_LIMIT,
  presentationCapabilities: SLACK_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload }) => {
    const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
    const resolution = resolveSlackOutboundBlockResolution(payload);
    return resolution.segments.length > 0
      ? withSlackRenderedPresentation(payload, slackData, resolution)
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
    const renderedResolution = readSlackRenderedPresentation(slackData);
    let resolution: SlackReplyBlockResolution;
    if (renderedResolution) {
      resolution = renderedResolution;
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
      toSlackOutboundResult(
        await sendPayloadMediaSequenceAndFinalize({
          text: "",
          mediaUrls,
          send: async ({ text, mediaUrl }) =>
            await sendSlackOutboundMessage({
              ...ctx,
              text,
              mediaUrl,
              deliveryQueueId: useSingleDeliveryMarker ? ctx.deliveryQueueId : undefined,
            }),
          finalize: async () => {
            let lastResult: Awaited<ReturnType<SlackSendFn>> | undefined;
            for (const message of deliveryMessages) {
              lastResult = await sendSlackOutboundMessage({
                ...ctx,
                text: message.text,
                ...(message.blocks ? { blocks: message.blocks } : {}),
                ...(message.authoredTextPlacement
                  ? { authoredTextPlacement: message.authoredTextPlacement }
                  : {}),
                ...(message.nativeDataFallbackBaseText
                  ? { nativeDataFallbackBaseText: message.nativeDataFallbackBaseText }
                  : {}),
                ...(message.textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
                deliveryQueueId: useSingleDeliveryMarker ? ctx.deliveryQueueId : undefined,
              });
            }
            if (!lastResult) {
              throw new Error("Slack rendered presentation produced no deliverable segment");
            }
            return lastResult;
          },
        }),
      ),
    );
  },
  afterDeliverPayload: async ({ cfg, target, payload, results }) => {
    const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
    const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
    if (!questionId) {
      return;
    }
    const resolution = readSlackRenderedPresentation(slackData);
    if (!resolution) {
      return;
    }
    const deliveryMessages = resolveSlackReplyDeliveryMessages({
      authoredTextPlacement: resolution.authoredTextPlacement,
      segments: resolution.segments,
      text: payload.text,
    });
    const deliveryMessage = deliveryMessages.find(
      (message) => resolveSlackQuestionActionIds(message.blocks).length > 0,
    );
    const questionActionIds = resolveSlackQuestionActionIds(deliveryMessage?.blocks);
    const result = results.find(
      ({ channel, meta }) =>
        channel === "slack" &&
        Array.isArray(meta?.slackQuestionActionIds) &&
        meta.slackQuestionActionIds.some(
          (actionId) => typeof actionId === "string" && questionActionIds.includes(actionId),
        ),
    );
    const deliveredDisplayBlocks = (result?.meta as SlackSendResult["meta"] | undefined)?.[
      SLACK_QUESTION_FINALIZATION_BLOCKS
    ];
    if (!deliveryMessage || !deliveredDisplayBlocks || !result?.messageId) {
      return;
    }
    const channelId = result.target?.kind === "channel" ? result.target.id : undefined;
    if (!channelId) {
      return;
    }
    const teamId = parseSlackTarget(target.to, { defaultKind: "channel" })?.teamId;
    // Aggregate fallback receipts retain their last platform id separately
    // from the actual card whose question controls need finalization.
    const questionMessageId =
      typeof result.meta?.slackQuestionMessageId === "string"
        ? result.meta.slackQuestionMessageId
        : result.messageId;
    questionGatewayRuntime.registerChannelDelivery({
      questionId,
      deliveryId: `slack:${target.accountId ?? "default"}:${channelId}:${questionMessageId}`,
      finalize: async (statusLine) => {
        const { updateMessageSlack } = await loadSlackSendRuntime();
        const escapedStatusLine = escapeSlackMrkdwn(statusLine);
        const blocks = [
          ...deliveredDisplayBlocks,
          { type: "context", elements: [{ type: "mrkdwn", text: escapedStatusLine }] },
        ];
        await updateMessageSlack({
          cfg,
          accountId: target.accountId ?? undefined,
          channelId,
          teamId,
          messageTs: questionMessageId,
          text: `${deliveryMessage.text}\n\n${escapedStatusLine}`,
          blocks,
        });
      },
    });
  },
  ...createSlackAttachedSendAdapter(),
};
