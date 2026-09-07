// Line plugin module owns typed rich-message schemas and native rendering.
import type { messagingApi } from "@line/bot-sdk";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  renderPresentationForDelivery,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
  type MessagePresentation,
  type MessagePresentationAction,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  resolveAskUserQuestionOptionIndices,
  type AskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
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
import { fitsLineFlexBubble } from "./flex-templates/message.js";
import { createAgendaCard, createEventCard } from "./flex-templates/schedule-cards.js";
import { buildLineQuestionPostbackData, type LineQuestionPostback } from "./question-postback.js";
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

/**
 * Reads the choice one question button carries. The Gateway owns option order, so a
 * tap sends the index it published, never the rendered label; a choice it no longer
 * lists renders no button at all rather than a tap that answers the wrong option.
 */
function toLineQuestionChoice(
  action: Extract<MessagePresentationAction, { type: "question" }>,
  questionOptionIndices: AskUserQuestionOptionIndices | undefined,
): LineQuestionPostback | undefined {
  if ("intent" in action) {
    // The free-text control is dropped before the card is built, so only a
    // declared choice ever reaches here.
    return undefined;
  }
  const optionIndex = resolveAskUserQuestionOptionIndex({
    questionOptionIndices,
    questionId: action.questionId,
    optionValue: action.optionValue,
  });
  return optionIndex === undefined ? undefined : { questionId: action.questionId, optionIndex };
}

/**
 * The free-text control is not drawn. LINE can open the composer on a tap
 * (`inputOption: "openKeyboard"`), so the platform is not the reason: an answer
 * is claimed only on the plain-text inbound path, which no postback reaches, so
 * the button cannot change whether what follows it counts as the answer. It
 * would add a tap that changes nothing the card's own words already offer, which
 * is why Discord and Slack leave that route in text too.
 */
function isLineTextFallbackButton(button: MessagePresentationButton): boolean {
  const action = resolveMessagePresentationButtonAction(button);
  return action?.type === "question" && "intent" in action && action.intent === "custom-input";
}

/** A control the Gateway owns, whose label the operator cannot disambiguate. */
function isLineQuestionButton(button: MessagePresentationButton): boolean {
  return resolveMessagePresentationButtonAction(button)?.type === "question";
}

function toLineAction(
  button: MessagePresentationButton,
  questionOptionIndices?: AskUserQuestionOptionIndices,
): Action | undefined {
  const normalized = resolveMessagePresentationButtonAction(button);
  const { label } = button;
  if (normalized?.type === "question") {
    const choice = toLineQuestionChoice(normalized, questionOptionIndices);
    const data = choice && buildLineQuestionPostbackData(choice);
    if (!data) {
      return undefined;
    }
    // The free-text control answers nothing by itself; opening the composer is
    // what it is for, and it is the only feedback the tap can give on a card
    // LINE will not let us edit afterwards.
    return { type: "postback", label, data, displayText: label };
  }
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

export function renderLinePresentation(payload: ReplyPayload, presentation: MessagePresentation) {
  const hasCard = presentation.blocks.some(
    (block) => block.type === "buttons" && block.buttons.length > 0,
  );
  const buttons: Array<{ label: string; action: Action }> = [];
  const quickReplyItems: LineQuickReplyItem[] = [];
  const carriedBlocks: MessagePresentationBlock[] = [];
  const cardBody: string[] = [];
  // Controls this renderer declines to draw. The shared adapter already names a
  // control it drops for budget under `Actions:`, so naming these the same way
  // keeps one wording for "offered, but not tappable here" no matter which layer
  // dropped it; without it a two- or three-option question loses the free-text
  // route from the card entirely.
  const omittedControlLabels: string[] = [];
  const questionLabels = new Set<string>();
  const questionOptionIndices = resolveAskUserQuestionOptionIndices(payload);
  for (const block of presentation.blocks) {
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        if (isLineTextFallbackButton(button)) {
          omittedControlLabels.push(button.label);
          continue;
        }
        const action = toLineAction(button, questionOptionIndices);
        if (!action) {
          return null;
        }
        // Two Gateway options are distinct by contract, but a label is truncated
        // to fit the control. Options that collide after that would be two
        // identical taps, so the whole reply falls back to text that still
        // distinguishes them.
        if (isLineQuestionButton(button)) {
          if (questionLabels.has(button.label)) {
            return null;
          }
          questionLabels.add(button.label);
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
  if (hasCard && omittedControlLabels.length > 0) {
    cardBody.push(`Actions:\n${omittedControlLabels.map((label) => `- ${label}`).join("\n")}`);
  }

  const lineData = isRecord(payload.channelData?.line) ? payload.channelData.line : {};
  const title = presentation.title || "Choose an option";
  // The card's own heading can be generic, but altText is the whole message in
  // the notification and the chat list, so it carries the words being asked.
  const altText = presentation.title || cardBody[0] || title;
  const flexMessage = hasCard
    ? {
        altText,
        contents: createActionCard(title, cardBody.join("\n") || "Choose an option.", buttons),
      }
    : undefined;
  if (flexMessage && !fitsLineFlexBubble(flexMessage.contents)) {
    return null;
  }
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
export async function prepareLineReplyPayload(payload: ReplyPayload): Promise<ReplyPayload> {
  if (!normalizeMessagePresentation(payload.presentation)) {
    return payload;
  }
  const usesFallbackText =
    payload.presentationTextMode === "fallback" && Boolean(payload.text?.trim());
  return renderPresentationForDelivery(
    {
      presentationCapabilities: LINE_PRESENTATION_CAPABILITIES,
      renderPresentation: (adapted) => {
        const rendered = renderLinePresentation(adapted, adapted.presentation);
        // Quick replies have no Flex body to replace the author's fallback prose.
        return rendered && usesFallbackText && rendered.channelData.line.flexMessage === undefined
          ? { ...rendered, text: payload.text }
          : rendered;
      },
    },
    { ...payload, presentationTextMode: usesFallbackText ? "fallback" : undefined },
  );
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
