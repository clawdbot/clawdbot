// Msteams plugin module implements presentation behavior.
import {
  adaptMessagePresentationForChannel,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelOutboundAdapter, ReplyPayload } from "../runtime-api.js";

export const MSTEAMS_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: false,
  context: true,
  divider: true,
  limits: {
    actions: {
      supportsStyles: false,
      supportsDisabled: false,
    },
    text: {
      markdownDialect: "markdown",
    },
  },
} satisfies ChannelOutboundAdapter["presentationCapabilities"];

const hasMSTeamsCardAction = (presentation: MessagePresentation): boolean =>
  presentation.blocks.some(
    (block) =>
      block.type === "buttons" && block.buttons.some((button) => resolveMSTeamsCardAction(button)),
  );

/**
 * The Teams card action for a control, or undefined when Teams has none for it and the
 * control can only reach the user as text. One owner for "what Teams renders natively",
 * so the card builder and the streaming remainder cannot disagree about it.
 */
export function resolveMSTeamsCardAction(
  button: Pick<
    MessagePresentationButton,
    "label" | "action" | "url" | "value" | "webApp" | "web_app"
  >,
): Record<string, unknown> | undefined {
  const action = resolveMessagePresentationButtonAction(button);
  if (action?.type === "url" || action?.type === "web-app") {
    const url = normalizeOptionalString(action.url);
    return url ? { type: "Action.OpenUrl", title: button.label, url } : undefined;
  }
  if (action?.type === "command") {
    return { type: "Action.Submit", title: button.label, data: action.command };
  }
  if (action?.type === "callback") {
    return {
      type: "Action.Submit",
      title: button.label,
      data: { value: action.value, label: button.label },
    };
  }
  return undefined;
}

export function buildMSTeamsPresentationCard(params: {
  presentation: MessagePresentation;
  text?: string | null;
}) {
  const body: Record<string, unknown>[] = [];
  const text = normalizeOptionalString(params.text);
  if (text) {
    body.push({
      type: "TextBlock",
      text,
      wrap: true,
    });
  }
  const presentation = adaptMessagePresentationForChannel({
    presentation: params.presentation,
    capabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
  });
  if (presentation.title) {
    body.push({
      type: "TextBlock",
      text: presentation.title,
      weight: "Bolder",
      size: "Medium",
      wrap: true,
    });
  }
  const actions: Record<string, unknown>[] = [];
  // Teams maps url, web-app, command and callback actions. A control carrying anything
  // else keeps its label as text, because a control that renders as nothing at all is
  // worse than one the user has to act on by replying.
  const unmappedLabels: string[] = [];
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      body.push({
        type: "TextBlock",
        text: block.text,
        wrap: true,
        ...(block.type === "context" ? { isSubtle: true, size: "Small" } : {}),
      });
      continue;
    }
    if (block.type === "divider") {
      body.push({ type: "TextBlock", text: "---", wrap: true, isSubtle: true });
      continue;
    }
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        const action = resolveMSTeamsCardAction(button);
        if (action) {
          actions.push(action);
          continue;
        }
        unmappedLabels.push(button.label);
      }
    }
  }
  if (unmappedLabels.length > 0) {
    body.push({
      type: "TextBlock",
      text: `Actions:\n${unmappedLabels.map((label) => `- ${label}`).join("\n")}`,
      wrap: true,
      isSubtle: true,
      size: "Small",
    });
  }
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body,
    ...(actions.length ? { actions } : {}),
  };
}

/**
 * Attach the Adaptive Card for an adapted presentation, or null when Teams cannot carry
 * one: a card and a media attachment cannot share an activity, so a reply with media
 * keeps its media and the caller degrades the controls to text.
 */
export function renderMSTeamsPresentationPayload(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): ReplyPayload | null {
  const { payload, presentation } = params;
  if (payload.mediaUrl || payload.mediaUrls?.length) {
    return null;
  }
  const card = buildMSTeamsPresentationCard({ presentation, text: payload.text });
  const msteamsData = asOptionalRecord(payload.channelData?.msteams) ?? {};
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      msteams: { ...msteamsData, presentationCard: card },
    },
  };
}

/** Reads the Adaptive Card a resolved reply carries, if any. */
export const readMSTeamsPresentationCard = (payload: ReplyPayload) =>
  asOptionalRecord(asOptionalRecord(payload.channelData?.msteams)?.presentationCard);

/**
 * Resolve a reply's portable presentation into a Teams Adaptive Card, keeping both Teams
 * delivery paths on one rendering. Mirrors core's renderer, including degrading controls
 * to text rather than dropping them when Teams cannot carry them natively.
 */
export function prepareMSTeamsReplyPayload(
  payload: ReplyPayload,
  options?: {
    /**
     * Answers whether this reply's text can live in one activity. A card cannot be
     * chunked and cannot carry a mention entity, so the caller owns that judgement.
     */
    fitsOneActivity?: (text: string) => boolean;
    /** Renders the card's text in the dialect the caller's text path would send. */
    formatCardText?: (text: string) => string;
  },
): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const { presentation: _presentation, presentationTextMode, ...rest } = payload;
  // "fallback" text already renders these controls as prose; the card replaces it.
  const textIsFallback = presentationTextMode === "fallback";
  const adapted = adaptMessagePresentationForChannel({
    presentation,
    capabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
  });
  // A card only earns a reply when Teams can draw at least one of its controls. Without
  // one the user gets an untappable frame, the reply's prose stops being the activity's
  // text - so notification previews lose it - and the labels are already appended to that
  // prose by the text rendering below.
  if (!hasMSTeamsCardAction(adapted)) {
    return replyWithControlsAsText();
  }
  // The gate asks whether this reply fits one activity, so it reads the reply's own text
  // even when the card will not carry it: fallback prose still holds the mention entity
  // only the text path can send. A reply that fails it keeps the text path and degrades
  // its controls to prose - the same trade the media branch makes.
  if (rest.text && options?.fitsOneActivity && !options.fitsOneActivity(rest.text)) {
    return replyWithControlsAsText();
  }
  const cardText = rest.text ? options?.formatCardText?.(rest.text) : undefined;
  const rendered = renderMSTeamsPresentationPayload({
    payload: textIsFallback
      ? { ...rest, text: undefined }
      : { ...rest, ...(cardText ? { text: cardText } : {}) },
    presentation: adapted,
  });
  return rendered ?? replyWithControlsAsText();

  function replyWithControlsAsText(): ReplyPayload {
    return {
      ...rest,
      text: textIsFallback
        ? (payload.text ?? renderMessagePresentationFallbackText({ presentation }))
        : renderMessagePresentationFallbackText({ text: payload.text, presentation }),
    };
  }
}
