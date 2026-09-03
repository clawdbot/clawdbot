// Feishu plugin module implements presentation card behavior.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderPresentationForDelivery,
  renderMessagePresentationFallbackText,
  renderMessagePresentationTableFallbackText,
  resolveLegacyInteractiveTextFallback,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OutboundIdentity, ReplyPayload } from "../runtime-api.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { resolveFeishuIdentityHeaderTitle } from "./identity-header.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent } from "./mention.js";
import {
  escapeFeishuCardMarkdownText,
  escapeFeishuCardPlainText,
  resolveSafeFeishuButtonUrl,
  readNativeFeishuCardJson,
  sanitizeNativeFeishuCard,
  type FeishuNativeCard,
} from "./native-card.js";

type NormalizedMessagePresentation = NonNullable<ReturnType<typeof normalizeMessagePresentation>>;
type FeishuPresentationTextFormat = "plain" | "markdown";
const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");
const FEISHU_PRESENTATION_FALLBACK_MARKER = "__openclawPresentationFallback";

export const FEISHU_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: false,
  context: true,
  divider: true,
  limits: {
    actions: {
      maxActions: 20,
      maxActionsPerRow: 5,
      maxLabelLength: 40,
      maxValueBytes: 1024,
    },
    text: {
      maxLength: 4000,
      encoding: "characters",
      markdownDialect: "markdown",
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

const FEISHU_CARD_MAX_BYTES = 30 * 1024;
const FEISHU_CARD_MAX_ELEMENTS = 200;

export function resolveFeishuRichReply(payload: { interactive?: unknown; presentation?: unknown }) {
  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  return {
    interactive,
    presentation:
      normalizeMessagePresentation(payload.presentation) ??
      (interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined),
  };
}

export function buildFeishuPresentationFallback(params: {
  text?: string;
  presentation?: NormalizedMessagePresentation;
  fallbackHasCommand?: boolean;
  textFormat?: FeishuPresentationTextFormat;
}) {
  const fallbackText = renderFeishuPresentationFallbackText(params, params.textFormat);
  // Only warn when the rendered fallback exposes a command the user can copy.
  const fallbackHasCommand =
    params.fallbackHasCommand === true ||
    params.presentation?.blocks.some((block) =>
      block.type === "select"
        ? block.options.some(({ action }) => action?.type === "command")
        : block.type === "buttons" &&
          block.buttons.some(({ action, disabled }) => !disabled && action?.type === "command"),
    ) === true;
  return {
    fallbackText,
    fallbackHasCommand,
    commentText: fallbackHasCommand
      ? `${fallbackText}\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.`
      : fallbackText,
  };
}

function countFeishuCardElements(value: unknown, ancestors = new Set<object>()): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countFeishuCardElements(entry, ancestors), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  if (ancestors.has(value)) {
    return FEISHU_CARD_MAX_ELEMENTS + 1;
  }
  ancestors.add(value);
  let count = typeof value.tag === "string" ? 1 : 0;
  for (const entry of Object.values(value)) {
    count += countFeishuCardElements(entry, ancestors);
    if (count > FEISHU_CARD_MAX_ELEMENTS) {
      break;
    }
  }
  ancestors.delete(value);
  return count;
}

export function isFeishuCardWithinEnvelope(card: Record<string, unknown>): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify(card), "utf8") <= FEISHU_CARD_MAX_BYTES &&
      countFeishuCardElements(card) <= FEISHU_CARD_MAX_ELEMENTS
    );
  } catch {
    return false;
  }
}

export function assertFeishuCardWithinEnvelope(
  card: Record<string, unknown>,
  label = "Feishu card",
): void {
  if (!isFeishuCardWithinEnvelope(card)) {
    throw new Error(`${label} exceeds the 30 KB or 200-element API limit.`);
  }
}

function resolveFeishuButtonUrl(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "url" || button.action?.type === "web-app") {
    return button.action.url;
  }
  if (button.action) {
    return undefined;
  }
  return button.url ?? button.webApp?.url ?? button.web_app?.url;
}

function resolveFeishuCommandButtonValue(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "command") {
    return button.action.command;
  }
  if (button.action) {
    return undefined;
  }
  return button.value;
}

export function renderFeishuPresentationFallbackText(
  params: Parameters<typeof renderMessagePresentationFallbackText>[0],
  textFormat: FeishuPresentationTextFormat = "plain",
): string {
  const presentation = params.presentation;
  return renderMessagePresentationFallbackText({
    ...params,
    presentation: presentation && {
      ...presentation,
      blocks: presentation.blocks.map((block) =>
        block.type === "buttons"
          ? {
              type: block.type,
              buttons: block.buttons.map((button) => {
                const url = resolveFeishuButtonUrl(button);
                // Reject the same targets everywhere; only Markdown transports escape labels.
                return {
                  ...button,
                  ...(textFormat === "markdown"
                    ? { label: escapeFeishuCardPlainText(button.label) }
                    : {}),
                  ...(url && !resolveSafeFeishuButtonUrl(url) ? { disabled: true } : {}),
                };
              }),
            }
          : block,
      ),
    },
  });
}

function mapFeishuButtonType(style: MessagePresentationButton["style"]) {
  if (style === "primary" || style === "success") {
    return "primary";
  }
  if (style === "danger") {
    return "danger";
  }
  return "default";
}

function buildFeishuPayloadButton(button: MessagePresentationButton): Record<string, unknown> {
  const url = resolveSafeFeishuButtonUrl(resolveFeishuButtonUrl(button));
  const value = resolveFeishuCommandButtonValue(button);
  if (button.disabled || (!url && !value)) {
    // Keep each unavailable control visible without exposing rejected URLs or opaque values.
    return { tag: "markdown", content: `- ${escapeFeishuCardPlainText(button.label)}` };
  }
  const behaviors: Record<string, unknown>[] = [];
  if (url) {
    behaviors.push({ type: "open_url", default_url: url });
  }
  if (value) {
    behaviors.push({
      type: "callback",
      value: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: "feishu.payload.button",
        q: value,
      }),
    });
  }
  return {
    tag: "button",
    text: { tag: "plain_text", content: button.label },
    type: mapFeishuButtonType(button.style),
    behaviors,
  };
}

function buildFeishuCardElementsForBlock(
  block: MessagePresentationBlock,
): Record<string, unknown>[] {
  if (block.type === "text") {
    return [{ tag: "markdown", content: escapeFeishuCardMarkdownText(block.text) }];
  }
  if (block.type === "context") {
    return [
      {
        tag: "markdown",
        content: `<font color='grey'>${escapeFeishuCardMarkdownText(block.text)}</font>`,
      },
    ];
  }
  if (block.type === "divider") {
    return [{ tag: "hr" }];
  }
  if (block.type === "buttons") {
    return block.buttons.map(buildFeishuPayloadButton);
  }
  if (block.type === "chart") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(renderMessagePresentationChartFallbackText(block)),
      },
    ];
  }
  if (block.type === "table") {
    return [
      {
        tag: "markdown",
        content: escapeFeishuCardMarkdownText(renderMessagePresentationTableFallbackText(block)),
      },
    ];
  }
  return [
    {
      tag: "markdown",
      content: escapeFeishuCardMarkdownText(
        renderMessagePresentationFallbackText({ presentation: { blocks: [block] } }),
      ),
    },
  ];
}

function resolvePresentationHeaderTemplate(tone: NormalizedMessagePresentation["tone"]) {
  if (tone === "danger") {
    return "red";
  }
  if (tone === "warning") {
    return "orange";
  }
  if (tone === "success") {
    return "green";
  }
  return "blue";
}

function buildFeishuPresentationCardElements(params: {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
}): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const fallbackText = params.fallbackText?.trim();
  if (fallbackText) {
    elements.push({
      tag: "markdown",
      content: escapeFeishuCardMarkdownText(fallbackText),
    });
  }
  for (const block of params.presentation.blocks) {
    for (const element of buildFeishuCardElementsForBlock(block)) {
      elements.push(element);
    }
  }
  if (elements.length > 0) {
    return elements;
  }
  return [{ tag: "markdown", content: "" }];
}

export function buildFeishuPresentationCard(params: {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
}): FeishuNativeCard {
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    ...(params.presentation.title
      ? {
          header: {
            title: { tag: "plain_text", content: params.presentation.title },
            template: resolvePresentationHeaderTemplate(params.presentation.tone),
          },
        }
      : {}),
    body: {
      elements: buildFeishuPresentationCardElements(params),
    },
  };
}

export function markRenderedFeishuCard(card: FeishuNativeCard): FeishuNativeCard {
  Object.defineProperty(card, RENDERED_FEISHU_CARD, {
    value: true,
    enumerable: false,
  });
  return card;
}

export function readNativeFeishuCard(payload: { channelData?: Record<string, unknown> }) {
  const feishuData = payload.channelData?.feishu;
  if (!isRecord(feishuData)) {
    return undefined;
  }
  const card = feishuData.card ?? feishuData.interactiveCard;
  if (!isRecord(card)) {
    return undefined;
  }
  const rendered = card as FeishuNativeCard & { [RENDERED_FEISHU_CARD]?: true };
  if (rendered[RENDERED_FEISHU_CARD] === true) {
    return rendered;
  }
  const sanitizedCard = sanitizeNativeFeishuCard(card);
  return sanitizedCard ? markRenderedFeishuCard(sanitizedCard) : undefined;
}

export function consumeFeishuPresentationFallbackMarker(payload: ReplyPayload): {
  payload: ReplyPayload;
  presentationFallback?: { hasVisibleContent: boolean };
} {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  const presentationFallback = feishuData?.[FEISHU_PRESENTATION_FALLBACK_MARKER];
  if (
    !isRecord(presentationFallback) ||
    typeof presentationFallback.hasVisibleContent !== "boolean"
  ) {
    return { payload };
  }
  const nextFeishuData = { ...feishuData };
  delete nextFeishuData[FEISHU_PRESENTATION_FALLBACK_MARKER];
  const nextChannelData = { ...payload.channelData };
  if (Object.keys(nextFeishuData).length > 0) {
    nextChannelData.feishu = nextFeishuData;
  } else {
    delete nextChannelData.feishu;
  }
  return {
    payload: {
      ...payload,
      channelData: Object.keys(nextChannelData).length > 0 ? nextChannelData : undefined,
    },
    presentationFallback: { hasVisibleContent: presentationFallback.hasVisibleContent },
  };
}

export function buildFeishuPayloadCard(params: {
  payload: ReplyPayload;
  text?: string;
  identity?: OutboundIdentity;
  mentions?: MentionTarget[];
}): FeishuNativeCard | undefined {
  const nativeCard = readNativeFeishuCard(params.payload);
  const rawText = params.text ?? params.payload.text;
  const textCard = readNativeFeishuCardJson(rawText);
  const { interactive, presentation } = resolveFeishuRichReply(params.payload);
  let card = nativeCard ?? (!presentation ? textCard : undefined);
  const isNativeCard = card !== undefined;
  if (!card && presentation) {
    card = buildFeishuPresentationCard({
      presentation: {
        ...presentation,
        title: presentation.title ?? resolveFeishuIdentityHeaderTitle(params.identity),
      },
      fallbackText: textCard
        ? undefined
        : resolveLegacyInteractiveTextFallback({ text: rawText, interactive }),
    });
  }
  if (!card) {
    return undefined;
  }
  if (params.mentions?.length) {
    // Ingress owns these recipients. Add their markup after sanitizing model-authored
    // content, and include it in the final native envelope budget.
    card = {
      ...card,
      body: {
        ...card.body,
        elements: [
          { tag: "markdown", content: buildMentionedCardContent(params.mentions, "").trimEnd() },
          ...card.body.elements,
        ],
      },
    };
  }
  if (isNativeCard) {
    assertFeishuCardWithinEnvelope(card, "Feishu native card");
  }
  return isFeishuCardWithinEnvelope(card) ? markRenderedFeishuCard(card) : undefined;
}

type FeishuPresentationContext = {
  to: string;
  identity?: OutboundIdentity;
  mentions?: MentionTarget[];
};

export function renderFeishuPresentationPayload({
  payload,
  presentation,
  sourcePresentation,
  ctx,
}: {
  payload: ReplyPayload;
  presentation: NormalizedMessagePresentation;
  sourcePresentation?: NormalizedMessagePresentation;
  ctx: FeishuPresentationContext;
}) {
  const card = buildFeishuPayloadCard({
    payload,
    text: payload.text,
    identity: ctx.identity,
    mentions: ctx.mentions,
  });
  const isComment = Boolean(parseFeishuCommentTarget(ctx.to));
  // Native limits may clip labels. A whole-card or comment fallback must retain
  // the authored labels; an accepted native card keeps its adapted projection.
  const fallbackPresentation =
    !card || isComment ? (sourcePresentation ?? presentation) : presentation;
  const { fallbackText, fallbackHasCommand } = buildFeishuPresentationFallback({
    text: readNativeFeishuCardJson(payload.text) ? undefined : payload.text,
    presentation: fallbackPresentation,
    textFormat: isComment ? "plain" : "markdown",
  });
  const existingFeishuData = isRecord(payload.channelData?.feishu)
    ? payload.channelData.feishu
    : undefined;
  if (!card) {
    // Core strips presentation from this post-queue transport copy. Preserve its
    // own visible contribution separately from prose already delivered by streaming.
    return {
      ...payload,
      text: fallbackText,
      channelData: {
        ...payload.channelData,
        feishu: {
          ...existingFeishuData,
          [FEISHU_PRESENTATION_FALLBACK_MARKER]: {
            hasVisibleContent: Boolean(
              renderFeishuPresentationFallbackText({ presentation: fallbackPresentation }).trim(),
            ),
          },
          ...(fallbackHasCommand ? { fallbackHasCommand: true } : {}),
        },
      },
    };
  }
  // Core consumes presentation before sendPayload; carry the fallback fact.
  return {
    ...payload,
    text: fallbackText,
    channelData: {
      ...payload.channelData,
      feishu: {
        ...existingFeishuData,
        card,
        ...(fallbackHasCommand ? { fallbackHasCommand: true } : {}),
      },
    },
  };
}

export async function renderFeishuReplyPayload(
  payload: ReplyPayload,
  ctx: FeishuPresentationContext,
): Promise<{ payload: ReplyPayload; card?: FeishuNativeCard }> {
  const { presentation } = resolveFeishuRichReply(payload);
  if (!presentation) {
    return { payload };
  }
  const rendered = await renderPresentationForDelivery(
    {
      presentationCapabilities: FEISHU_PRESENTATION_CAPABILITIES,
      renderPresentation: (adapted, sourcePresentation) =>
        renderFeishuPresentationPayload({
          payload: adapted,
          presentation: adapted.presentation,
          sourcePresentation,
          ctx,
        }),
    },
    { ...payload, presentation },
  );
  // Legacy controls have now been consumed too; a fallback must not render them again.
  const { interactive: _interactive, ...withoutInteractive } = rendered;
  return { payload: withoutInteractive, card: readNativeFeishuCard(withoutInteractive) };
}
