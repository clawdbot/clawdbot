// Line plugin module owns typed rich-message schemas and native rendering.
import type { messagingApi } from "@line/bot-sdk";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
  type MessagePresentation,
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
import { messageAction, postbackAction, uriAction, type Action } from "./actions.js";
import {
  createActionCard,
  createAgendaCard,
  createAppleTvRemoteCard,
  createDeviceControlCard,
  createEventCard,
  createMediaPlayerCard,
} from "./flex-templates.js";
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

export const LINE_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  limits: {
    actions: { maxActions: 4, maxActionsPerRow: 1, maxRows: 4, maxLabelLength: 40 },
    selects: { maxOptions: 13, maxLabelLength: 20, maxValueBytes: 300 },
    text: { markdownDialect: "plain" },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

function toLineAction(button: MessagePresentationButton): Action | undefined {
  const normalized = resolveMessagePresentationButtonAction(button);
  if (normalized?.type === "command") {
    return messageAction(button.label, normalized.command);
  }
  if (normalized?.type === "callback") {
    return postbackAction(button.label, normalized.value, button.label);
  }
  if (normalized?.type === "url") {
    return uriAction(button.label, normalized.url);
  }
  if (normalized?.type === "web-app" && normalized.url) {
    return uriAction(button.label, normalized.url);
  }
  return undefined;
}

export function renderLinePresentation(
  payload: ReplyPayload,
  presentation: MessagePresentation,
): ReplyPayload | null {
  const buttons = presentation.blocks.flatMap((block) =>
    block.type === "buttons" ? block.buttons : [],
  );
  const buttonActions = buttons.map(toLineAction);
  const options = presentation.blocks.flatMap((block) =>
    block.type === "select" ? block.options : [],
  );
  const quickReplyItems = options.flatMap<LineQuickReplyItem>((option) => {
    const action = resolveMessagePresentationOptionAction(option);
    return action?.type === "command" || action?.type === "callback"
      ? [{ label: option.label, action }]
      : [];
  });
  if (
    (buttons.length > 0 && buttonActions.some((action) => !action)) ||
    quickReplyItems.length !== options.length ||
    (buttons.length === 0 && options.length === 0)
  ) {
    return null;
  }

  const lineData = isRecord(payload.channelData?.line) ? payload.channelData.line : {};
  const text = presentation.blocks
    .flatMap((block) => (block.type === "text" || block.type === "context" ? [block.text] : []))
    .join("\n");
  const title = presentation.title || "Choose an option";
  const flexMessage =
    buttonActions.length > 0
      ? {
          altText: title,
          contents: createActionCard(
            title,
            text || "Choose an option.",
            buttons.map((button, index) => ({
              label: button.label,
              action: buttonActions[index]!,
            })),
          ),
        }
      : undefined;
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      line: { ...lineData, ...(flexMessage ? { flexMessage } : {}), quickReplyItems },
    },
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
    items: items.slice(0, 13).map((item) => ({
      type: "action",
      action:
        item.action.type === "command"
          ? messageAction(item.label, item.action.command)
          : postbackAction(item.label, item.action.value, item.label),
    })),
  };
}
