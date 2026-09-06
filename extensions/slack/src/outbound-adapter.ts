// Slack plugin module implements outbound adapter behavior.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveOutboundSendDep,
  type OutboundIdentity,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
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
import { resolveSlackAccount, resolveSlackOperationToken } from "./accounts.js";
import {
  resolveSlackAuthoredTextPlacement,
  type SlackAuthoredTextPlacement,
} from "./authored-text.js";
import { assertSlackDetachedTargetAllowed } from "./detached-target-admission.js";
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
import { mergeSlackSendResults } from "./send-results.js";
import type { SlackSendIdentity, SlackSendResult } from "./send.js";
import { parseSlackTarget } from "./target-parsing.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";

type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

function toSlackOutboundResult<T extends { channelId?: string }>(result: T) {
  const { channelId, ...delivery } = result;
  return attachChannelToResult(
    "slack",
    channelId === undefined
      ? delivery
      : { ...delivery, target: { kind: "channel" as const, id: channelId } },
  );
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

type SlackOutboundSendParams = ChannelOutboundContext &
  Pick<
    Parameters<SlackSendFn>[2],
    "blocks" | "authoredTextPlacement" | "nativeDataFallbackBaseText" | "textIsSlackPlainText"
  >;

async function prepareSlackOutboundSend(ctx: ChannelOutboundContext) {
  // Sends require the scoped runtime snapshot, including resolved active credentials.
  // Admission also applies to injected senders, before any platform work begins.
  const account = resolveSlackAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
  const target = parseSlackTarget(ctx.to, { defaultKind: "channel" });
  assertSlackDetachedTargetAllowed(account.accountId, target?.teamId);
  const send =
    resolveOutboundSendDep<SlackSendFn>(ctx.deps, "slack") ??
    (await loadSlackSendRuntime()).sendMessageSlack;
  const token = resolveSlackOperationToken(account, "write");
  const botToken = account.botToken?.trim();
  const tokenOverride = token && token !== botToken ? token : undefined;
  return async (params: SlackOutboundSendParams) => {
    const slackIdentity = resolveSlackSendIdentity(params.identity);
    const threadTs = resolveSlackThreadTsValue(params);
    const sendOptions: Parameters<SlackSendFn>[2] = {
      cfg: params.cfg,
      ...(tokenOverride ? { token: tokenOverride } : {}),
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
              await params.onDeliveryResult?.(toSlackOutboundResult(progress));
            },
          }
        : {}),
    };
    return await send(params.to, params.text, sendOptions);
  };
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
    const send = await prepareSlackOutboundSend(ctx);
    // Media belongs to each media unit, never to subsequent card or text sends.
    const { mediaUrl: _mediaUrl, ...commonCtx } = ctx;
    const preparedCtx = {
      ...commonCtx,
      replyToId: resolveSlackThreadTsValue(ctx),
      // Keeping the fallback thread would resurrect an implicit reply consumed by fanout.
      threadId: null,
      // Only text sends can reconcile an unknown send with one provider marker.
      deliveryQueueId: undefined,
    };
    const payload = {
      ...preparedCtx.payload,
      text:
        resolveLegacyInteractiveTextFallback({
          text: preparedCtx.payload.text,
          interactive: preparedCtx.payload.interactive,
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
      const sendPart = async (part: ChannelOutboundContext) =>
        toSlackOutboundResult(await send(part));
      return await sendTextMediaPayload({
        channel: "slack",
        ctx: { ...preparedCtx, payload },
        adapter: { sendText: sendPart, sendMedia: sendPart },
      });
    }
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const deliveryMessages = resolveSlackReplyDeliveryMessages({
      authoredTextPlacement: resolution.authoredTextPlacement,
      segments: resolution.segments,
      text: payload.text,
    });
    const sentResults: Awaited<ReturnType<SlackSendFn>>[] = [];
    return toSlackOutboundResult(
      await sendPayloadMediaSequenceAndFinalize({
        text: "",
        mediaUrls,
        send: async ({ text, mediaUrl }) =>
          await send({
            ...preparedCtx,
            text,
            mediaUrl,
          }),
        onResult: (result) => {
          sentResults.push(result);
        },
        finalize: async () => {
          for (const message of deliveryMessages) {
            sentResults.push(
              await send({
                ...preparedCtx,
                text: message.text,
                ...(message.blocks ? { blocks: message.blocks } : {}),
                ...(message.authoredTextPlacement
                  ? { authoredTextPlacement: message.authoredTextPlacement }
                  : {}),
                ...(message.nativeDataFallbackBaseText
                  ? { nativeDataFallbackBaseText: message.nativeDataFallbackBaseText }
                  : {}),
                ...(message.textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
              }),
            );
          }
          return mergeSlackSendResults(sentResults);
        },
      }),
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
  sendText: async (ctx) => {
    const send = await prepareSlackOutboundSend(ctx);
    return toSlackOutboundResult(await send(ctx));
  },
  sendMedia: async (ctx) => {
    const send = await prepareSlackOutboundSend(ctx);
    return toSlackOutboundResult(await send({ ...ctx, deliveryQueueId: undefined }));
  },
};
