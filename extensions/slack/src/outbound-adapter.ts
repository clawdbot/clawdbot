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
import { SLACK_PRESENTATION_CAPABILITIES } from "./presentation.js";
import { registerSlackQuestionDelivery } from "./question-delivery.js";
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
  onQuestionControlDelivery?: NonNullable<Parameters<SlackSendFn>[2]>["onQuestionControlDelivery"];
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
    ...(params.onQuestionControlDelivery
      ? { onQuestionControlDelivery: params.onQuestionControlDelivery }
      : {}),
  };
  const result = await send(params.to, params.text, sendOptions);
  return result;
}

function createSlackAttachedSendAdapter() {
  return createAttachedChannelResultAdapter({
    channel: "slack",
    sendText: sendSlackOutboundMessage,
    sendMedia: sendSlackOutboundMessage,
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
    const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
    const useSingleDeliveryMarker = mediaUrls.length === 0 && deliveryMessages.length === 1;
    return attachChannelToResult(
      "slack",
      await sendPayloadMediaSequenceAndFinalize({
        text: "",
        mediaUrls,
        send: async ({ text, mediaUrl }) =>
          await sendSlackOutboundMessage({
            ...ctx,
            text,
            mediaUrl,
            deliveryQueueId: useSingleDeliveryMarker ? ctx.deliveryQueueId : undefined,
            onPlatformSendDispatch: useSingleDeliveryMarker
              ? ctx.onPlatformSendDispatch
              : undefined,
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
              onPlatformSendDispatch: useSingleDeliveryMarker
                ? ctx.onPlatformSendDispatch
                : undefined,
              ...(questionId && message.blocks?.some((block) => block.type === "actions")
                ? {
                    // Capture actual posted controls, not a send's aggregate fallback receipt.
                    onQuestionControlDelivery: (delivery) => {
                      registerSlackQuestionDelivery({
                        questionId,
                        accountId: ctx.accountId ?? undefined,
                        ...delivery,
                        update: async ({ channelId, messageTs, text, blocks }) => {
                          const { updateMessageSlack } = await loadSlackSendRuntime();
                          await updateMessageSlack({
                            cfg: ctx.cfg,
                            accountId: ctx.accountId ?? undefined,
                            channelId,
                            messageTs,
                            text,
                            blocks,
                          });
                        },
                      });
                    },
                  }
                : {}),
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
  ...createSlackAttachedSendAdapter(),
};
