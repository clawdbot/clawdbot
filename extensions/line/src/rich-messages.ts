// Line plugin module owns typed rich-message schemas and native rendering.
import type { messagingApi } from "@line/bot-sdk";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  adaptMessagePresentationForChannel,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
  type MessagePresentation,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { hasLineCredentials } from "./account-helpers.js";
import { resolveLineAccount } from "./accounts.js";
import { messageAction, postbackAction, type Action } from "./actions.js";
import { createActionCard } from "./flex-templates/basic-cards.js";
import {
  createAppleTvRemoteCard,
  createDeviceControlCard,
  createMediaPlayerCard,
} from "./flex-templates/media-control-cards.js";
import { createAgendaCard, createEventCard } from "./flex-templates/schedule-cards.js";
import type { LineQuickReplyItem, LineRichCard } from "./types.js";

const nonempty = () => Type.String({ minLength: 1 });
const closed = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const lineCardSchema = Type.Union([
  closed({
    type: Type.Literal("media_player"),
    title: nonempty(),
    artist: Type.Optional(nonempty()),
    source: Type.Optional(nonempty()),
    imageUrl: Type.Optional(Type.String({ pattern: "^https://" })),
    status: Type.Optional(Type.Union([Type.Literal("playing"), Type.Literal("paused")])),
  }),
  closed({
    type: Type.Literal("event"),
    title: nonempty(),
    date: nonempty(),
    time: Type.Optional(nonempty()),
    location: Type.Optional(nonempty()),
    description: Type.Optional(nonempty()),
  }),
  closed({
    type: Type.Literal("agenda"),
    title: nonempty(),
    events: Type.Array(
      closed({
        title: nonempty(),
        time: Type.Optional(nonempty()),
        location: Type.Optional(nonempty()),
      }),
      { minItems: 1, maxItems: 6 },
    ),
  }),
  closed({
    type: Type.Literal("device"),
    name: nonempty(),
    deviceType: Type.Optional(nonempty()),
    status: Type.Optional(nonempty()),
    controls: Type.Optional(
      Type.Array(closed({ label: nonempty(), action: nonempty() }), { maxItems: 6 }),
    ),
  }),
  closed({
    type: Type.Literal("appletv_remote"),
    name: Type.Optional(nonempty()),
    status: Type.Optional(nonempty()),
  }),
]);

const lineChannelDataSchema = Type.Optional(
  closed({
    line: closed({
      location: Type.Optional(
        closed({
          title: nonempty(),
          address: nonempty(),
          latitude: Type.Number({ minimum: -90, maximum: 90 }),
          longitude: Type.Number({ minimum: -180, maximum: 180 }),
        }),
      ),
      card: Type.Optional(lineCardSchema),
      mediaKind: Type.Optional(
        Type.Union([Type.Literal("image"), Type.Literal("video"), Type.Literal("audio")]),
      ),
      previewImageUrl: Type.Optional(Type.String({ pattern: "^https://" })),
      durationMs: Type.Optional(Type.Integer({ minimum: 1 })),
      trackingId: Type.Optional(nonempty()),
    }),
  }),
);

export const lineMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const account = resolveLineAccount({ cfg, accountId: accountId ?? undefined });
    return account.enabled && hasLineCredentials(account)
      ? {
          actions: ["send"],
          capabilities: ["presentation"],
          schema: {
            actions: ["send"],
            properties: { channelData: lineChannelDataSchema },
          },
        }
      : { actions: [], capabilities: [], schema: null };
  },
  prepareSendPayload: ({ payload }) => payload,
};

// LINE's 13-item quick-reply budget is shared by every select in one message.
const LINE_QUICK_REPLY_LIMIT = 13;

export const LINE_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  limits: {
    actions: { maxActions: 4, maxActionsPerRow: 1, maxRows: 4, maxLabelLength: 40 },
    // Native action encoding bounds labels; clipping here also loses plain-text
    // placeholders and option names that overflow the shared quick-reply row.
    selects: { maxOptions: LINE_QUICK_REPLY_LIMIT, maxValueBytes: 300 },
    text: { markdownDialect: "plain" },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

function toLineAction(button: MessagePresentationButton): Action | undefined {
  const normalized = resolveMessagePresentationButtonAction(button);
  const { label } = button;
  if (normalized?.type === "command") {
    return { type: "message", label, text: normalized.command };
  }
  if (normalized?.type === "callback") {
    return { type: "postback", label, data: normalized.value, displayText: label };
  }
  if (normalized?.type === "url") {
    return { type: "uri", label, uri: normalized.url };
  }
  if (normalized?.type === "web-app" && normalized.url) {
    return { type: "uri", label, uri: normalized.url };
  }
  return undefined;
}

export function renderLinePresentation(
  payload: ReplyPayload,
  presentation: MessagePresentation,
): ReplyPayload | null {
  const hasCard = presentation.blocks.some(
    (block) => block.type === "buttons" && block.buttons.length > 0,
  );
  const buttons: Array<{ label: string; action: Action }> = [];
  const quickReplyItems: LineQuickReplyItem[] = [];
  const carriedBlocks: MessagePresentationBlock[] = [];
  const cardBody: string[] = [];
  for (const block of presentation.blocks) {
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        const action = toLineAction(button);
        if (!action) {
          return null;
        }
        buttons.push({ label: button.label, action });
      }
    } else if (block.type === "select") {
      const overflow: typeof block.options = [];
      for (const option of block.options) {
        const action = resolveMessagePresentationOptionAction(option);
        if (!action) {
          return null;
        }
        if (quickReplyItems.length < LINE_QUICK_REPLY_LIMIT) {
          quickReplyItems.push({ label: option.label, action });
        } else {
          overflow.push(option);
        }
      }
      // Keep each prompt beside its own overflow; an empty select would lose its
      // placeholder in the fallback renderer even though its chips still need it.
      if (overflow.length > 0) {
        carriedBlocks.push({ ...block, options: overflow });
      } else if (block.placeholder) {
        carriedBlocks.push({ type: "context", text: block.placeholder });
      }
    } else if (!hasCard) {
      carriedBlocks.push(block);
    } else if (block.type === "text" || block.type === "context") {
      cardBody.push(block.text);
    }
  }
  if (buttons.length === 0 && quickReplyItems.length === 0) {
    return null;
  }

  const lineData = isRecord(payload.channelData?.line) ? payload.channelData.line : {};
  const title = presentation.title || "Choose an option";
  const flexMessage = hasCard
    ? {
        altText: title,
        contents: createActionCard(title, cardBody.join("\n") || "Choose an option.", buttons),
      }
    : undefined;
  const text = renderMessagePresentationFallbackText({
    text: payload.text,
    presentation: { title: hasCard ? undefined : presentation.title, blocks: carriedBlocks },
  });
  return {
    ...payload,
    ...(text ? { text } : {}),
    channelData: {
      ...payload.channelData,
      line: {
        ...lineData,
        ...(flexMessage ? { flexMessage } : {}),
        quickReplyItems,
      },
    },
  };
}

/**
 * Resolve a reply's portable presentation into LINE-native controls.
 *
 * Core runs the presentation renderer inside the outbound send pipeline only, so
 * replies the plugin delivers itself reach delivery with the controls still
 * portable. Preparing them here keeps both LINE delivery paths on one rendering.
 */
export function prepareLineReplyPayload(payload: ReplyPayload): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const { presentation: _presentation, presentationTextMode, ...rest } = payload;
  // "fallback" text already renders these controls as prose; native ones replace it.
  const usesFallbackText = presentationTextMode === "fallback" && Boolean(rest.text?.trim());
  const rendered = renderLinePresentation(
    usesFallbackText ? { ...rest, text: undefined } : rest,
    adaptMessagePresentationForChannel({
      presentation,
      capabilities: LINE_PRESENTATION_CAPABILITIES,
    }),
  );
  if (rendered) {
    // Only a Flex body replaces the fallback prose. Without a card the renderer
    // rebuilds the words it could not draw, and the author's own fallback text
    // is the better rendering of the same facts, so it wins.
    const renderedLine = isRecord(rendered.channelData?.line) ? rendered.channelData.line : {};
    return usesFallbackText && renderedLine.flexMessage === undefined
      ? { ...rendered, text: rest.text }
      : rendered;
  }
  // LINE renders these controls natively or not at all; keep their labels visible.
  return {
    ...rest,
    text: usesFallbackText
      ? (rest.text ?? renderMessagePresentationFallbackText({ presentation }))
      : renderMessagePresentationFallbackText({ text: rest.text, presentation }),
  };
}

const toSlug = (value: string): string =>
  normalizeLowercaseStringOrEmpty(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "device";

const lineActionData = (action: string, device: string): string =>
  `line.action=${encodeURIComponent(action)}&line.device=${encodeURIComponent(device)}`;

export function renderLineCard(card: LineRichCard): { altText: string; contents: unknown } {
  if (card.type === "media_player") {
    const device = toSlug(card.source || card.title);
    return {
      altText: `🎵 ${card.title}${card.artist ? ` - ${card.artist}` : ""}`,
      contents: createMediaPlayerCard({
        title: card.title,
        subtitle: card.artist,
        source: card.source,
        imageUrl: card.imageUrl,
        isPlaying: card.status ? card.status === "playing" : undefined,
        controls: Object.fromEntries(
          ["previous", "play", "pause", "next"].map((action) => [
            action,
            { data: lineActionData(action, device) },
          ]),
        ),
      }),
    };
  }
  if (card.type === "event") {
    return {
      altText: `📅 ${card.title} - ${card.date}${card.time ? ` ${card.time}` : ""}`,
      contents: createEventCard(card),
    };
  }
  if (card.type === "agenda") {
    return {
      altText: `📋 ${card.title} (${card.events.length} events)`,
      contents: createAgendaCard(card),
    };
  }
  const device = toSlug(card.type === "device" ? card.name : card.name || "apple_tv");
  if (card.type === "device") {
    return {
      altText: `📱 ${card.name}${card.status ? `: ${card.status}` : ""}`,
      contents: createDeviceControlCard({
        deviceName: card.name,
        deviceType: card.deviceType,
        status: card.status,
        controls: (card.controls ?? []).map((control) => ({
          label: control.label,
          data: lineActionData(control.action, device),
        })),
      }),
    };
  }
  const actionData: Parameters<typeof createAppleTvRemoteCard>[0]["actionData"] = {
    up: lineActionData("up", device),
    down: lineActionData("down", device),
    left: lineActionData("left", device),
    right: lineActionData("right", device),
    select: lineActionData("select", device),
    menu: lineActionData("menu", device),
    home: lineActionData("home", device),
    play: lineActionData("play", device),
    pause: lineActionData("pause", device),
    volumeUp: lineActionData("volume_up", device),
    volumeDown: lineActionData("volume_down", device),
    mute: lineActionData("mute", device),
  };
  return {
    altText: `📺 ${card.name || "Apple TV"} Remote`,
    contents: createAppleTvRemoteCard({
      deviceName: card.name || "Apple TV",
      status: card.status,
      actionData,
    }),
  };
}

export function createLineQuickReply(items: LineQuickReplyItem[]): messagingApi.QuickReply {
  return {
    items: items.slice(0, LINE_QUICK_REPLY_LIMIT).map((item) => ({
      type: "action",
      action:
        item.action.type === "command"
          ? messageAction(item.label, item.action.command)
          : postbackAction(item.label, item.action.value, item.label),
    })),
  };
}
