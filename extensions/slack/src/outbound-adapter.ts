// Slack plugin module implements outbound adapter behavior.
import type { OutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolveInteractiveTextFallback,
  type InteractiveReply,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceAndFinalize,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseSlackBlocksInput, SLACK_MAX_BLOCKS } from "./blocks-input.js";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocks,
  resolveSlackBlockOffsets,
  type SlackBlock,
} from "./blocks-render.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "./interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { SLACK_PRESENTATION_CAPABILITIES, SLACK_SECTION_TEXT_MAX } from "./presentation.js";
import { resolveSlackReplyRenderPlan, resolveSlackReplyText } from "./reply-blocks.js";
import type { SlackSendIdentity } from "./send.js";
import { resolveSlackThreadTsValue } from "./thread-ts.js";

type SlackSendFn = typeof import("./send.runtime.js").sendMessageSlack;

type SlackOutboundChannelData = Record<string, unknown> & {
  blocks?: unknown;
  presentationBlocks?: SlackBlock[];
  presentationFallbackText?: string;
};

const loadSlackSendRuntime = createLazyRuntimeModule(() => import("./send.runtime.js"));

function resolveRenderedInteractiveBlocks(
  interactive?: InteractiveReply,
  previousBlocks?: readonly SlackBlock[],
): SlackBlock[] | undefined {
  if (!interactive) {
    return undefined;
  }
  const blocks = buildSlackInteractiveBlocks(interactive, resolveSlackBlockOffsets(previousBlocks));
  return blocks.length > 0 ? blocks : undefined;
}

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

function buildSlackTextSectionBlocks(text: string): SlackBlock[] {
  return markdownToSlackMrkdwnChunks(text.trim(), SLACK_SECTION_TEXT_MAX).map(
    (chunk): SlackBlock => ({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    }),
  );
}

function normalizeComparableSlackText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isPayloadTextRepresentedInInteractive(
  text: string,
  interactive?: InteractiveReply,
): boolean {
  const target = normalizeComparableSlackText(text);
  const fragments =
    interactive?.blocks.flatMap((block) =>
      block.type === "text" ? [normalizeComparableSlackText(block.text)] : [],
    ) ?? [];
  // Legacy inline controls split surrounding text into multiple interactive text blocks.
  for (let start = 0; start < fragments.length; start += 1) {
    let combined = "";
    for (let end = start; end < fragments.length; end += 1) {
      combined = normalizeComparableSlackText(`${combined} ${fragments[end]}`);
      if (combined === target) {
        return true;
      }
      if (combined.length > target.length) {
        break;
      }
    }
  }
  return false;
}

function buildSlackVisiblePayloadTextBlocks(payload: ReplyPayload): SlackBlock[] {
  const text = normalizeOptionalString(payload.text);
  if (!text || isPayloadTextRepresentedInInteractive(text, payload.interactive)) {
    return [];
  }
  return buildSlackTextSectionBlocks(text);
}

function withSlackPresentationData(
  payload: ReplyPayload,
  slackData: SlackOutboundChannelData | undefined,
  presentationData: Pick<
    SlackOutboundChannelData,
    "presentationBlocks" | "presentationFallbackText"
  >,
): ReplyPayload {
  const {
    presentationBlocks: _presentationBlocks,
    presentationFallbackText: _presentationFallbackText,
    ...preservedSlackData
  } = slackData ?? {};
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      slack: { ...preservedSlackData, ...presentationData },
    },
  };
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
  separateTextAndBlocks?: boolean;
  textIsSlackMrkdwn?: boolean;
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
  const result = await send(params.to, params.text, {
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
    ...(params.separateTextAndBlocks ? { separateTextAndBlocks: true } : {}),
    ...(params.textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
    ...(slackIdentity ? { identity: slackIdentity } : {}),
    deliveryQueueId: params.deliveryQueueId,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    onDeliveryResult: params.onDeliveryResult
      ? async (progress) => {
          await params.onDeliveryResult?.(attachChannelToResult("slack", progress));
        }
      : undefined,
  });
  return result;
}

function createSlackAttachedSendAdapter(textIsSlackMrkdwn = false) {
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
        textIsSlackMrkdwn,
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
      onPlatformSendDispatch,
      onDeliveryResult,
    }) =>
      await sendSlackOutboundMessage({
        cfg,
        to,
        text,
        textIsSlackMrkdwn,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        accountId,
        deps,
        replyToId,
        threadId,
        identity,
        onPlatformSendDispatch,
        onDeliveryResult,
      }),
  });
}

function resolveSlackBlocks(payload: {
  channelData?: Record<string, unknown>;
  interactive?: InteractiveReply;
  presentation?: MessagePresentation;
  text?: string;
}) {
  const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
  const nativeBlocks = parseSlackBlocksInput(slackData?.blocks) as SlackBlock[] | undefined;
  const renderedPresentation =
    slackData?.presentationBlocks ??
    (payload.presentation
      ? [
          ...buildSlackVisiblePayloadTextBlocks(payload),
          ...buildSlackPresentationBlocks(
            payload.presentation,
            resolveSlackBlockOffsets(nativeBlocks),
          ),
        ]
      : []);
  const previousBlocks = [...(nativeBlocks ?? []), ...renderedPresentation];
  const renderedInteractive = resolveRenderedInteractiveBlocks(payload.interactive, previousBlocks);
  const mergedBlocks = [...previousBlocks, ...(renderedInteractive ?? [])];
  if (mergedBlocks.length === 0) {
    return undefined;
  }
  if (mergedBlocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(
      `Slack blocks cannot exceed ${SLACK_MAX_BLOCKS} items after interactive render`,
    );
  }
  return mergedBlocks;
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
  renderPresentation: ({ payload, presentation, ctx }) => {
    const payloadForBudget = isSlackInteractiveRepliesEnabled({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
    })
      ? compileSlackInteractiveReplies(payload)
      : payload;
    const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
    const nativeBlocks = parseSlackBlocksInput(slackData?.blocks) as SlackBlock[] | undefined;
    const renderPlan = resolveSlackReplyRenderPlan(
      {
        presentation,
        interactive: payloadForBudget.interactive,
        ...(nativeBlocks?.length ? { channelData: { slack: { blocks: nativeBlocks } } } : {}),
      },
      payloadForBudget.text,
    );
    const { blocks: _blocks, ...slackDataWithoutBlocks } = slackData ?? {};
    if (renderPlan.mode === "split") {
      // Native and interactive blocks remain authored content during presentation fallback.
      // Ordinary Slack validation still rejects them rather than silently dropping them.
      return withSlackPresentationData(
        { ...payloadForBudget, text: renderPlan.hookText, interactive: undefined },
        slackDataWithoutBlocks,
        {
          presentationBlocks: renderPlan.blockPart?.blocks ?? [],
          presentationFallbackText: renderPlan.fallbackText,
        },
      );
    }
    // The planner owns block ordering, offsets, and complete accessibility text.
    // Rebuilding any subset here can duplicate or hide authored Slack content.
    return withSlackPresentationData(
      { ...payloadForBudget, text: renderPlan.text, interactive: undefined },
      slackDataWithoutBlocks,
      { presentationBlocks: renderPlan.blocks ?? [] },
    );
  },
  sendPayload: async (ctx) => {
    const payload = {
      ...ctx.payload,
      text:
        resolveInteractiveTextFallback({
          text: ctx.payload.text,
          interactive: ctx.payload.interactive,
        }) ?? "",
    };
    const accessibleText = resolveSlackReplyText(payload);
    const slackData = payload.channelData?.slack as SlackOutboundChannelData | undefined;
    const presentationFallbackText = normalizeOptionalString(slackData?.presentationFallbackText);
    const textIsSlackMrkdwn = Boolean(
      presentationFallbackText ||
      payload.presentation?.blocks.some(
        (block) => block.type === "chart" || block.type === "table",
      ),
    );
    const blocks = resolveSlackBlocks(payload);
    if (!blocks) {
      return await sendTextMediaPayload({
        channel: "slack",
        ctx: {
          ...ctx,
          payload: presentationFallbackText
            ? {
                ...payload,
                text: presentationFallbackText,
              }
            : { ...payload, text: accessibleText },
        },
        adapter: presentationFallbackText
          ? { ...slackOutbound, ...createSlackAttachedSendAdapter(true) }
          : slackOutbound,
      });
    }
    const mediaUrls = resolvePayloadMediaUrls(payload);
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
            onDeliveryResult: ctx.onDeliveryResult,
          }),
        finalize: async () => {
          return await sendSlackOutboundMessage({
            cfg: ctx.cfg,
            to: ctx.to,
            text: presentationFallbackText ?? accessibleText,
            ...(presentationFallbackText
              ? { separateTextAndBlocks: true, textIsSlackMrkdwn: true }
              : textIsSlackMrkdwn
                ? { textIsSlackMrkdwn: true }
                : {}),
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            blocks,
            accountId: ctx.accountId,
            deps: ctx.deps,
            replyToId: ctx.replyToId,
            threadId: ctx.threadId,
            identity: ctx.identity,
            ...(mediaUrls.length === 0
              ? {
                  deliveryQueueId: ctx.deliveryQueueId,
                  onPlatformSendDispatch: ctx.onPlatformSendDispatch,
                }
              : {}),
            onDeliveryResult: ctx.onDeliveryResult,
          });
        },
      }),
    );
  },
  ...createSlackAttachedSendAdapter(),
};
