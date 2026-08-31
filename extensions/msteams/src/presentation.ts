// Msteams plugin module implements presentation behavior.
import {
  adaptMessagePresentationForChannel,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationBlock,
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
        const action = resolveMessagePresentationButtonAction(button);
        if (action?.type === "url" || action?.type === "web-app") {
          const url = normalizeOptionalString(action.url);
          if (!url) {
            continue;
          }
          actions.push({
            type: "Action.OpenUrl",
            title: button.label,
            url,
          });
          continue;
        }
        if (action?.type === "command") {
          actions.push({
            type: "Action.Submit",
            title: button.label,
            data: action.command,
          });
          continue;
        }
        if (action?.type === "callback") {
          actions.push({
            type: "Action.Submit",
            title: button.label,
            data: { value: action.value, label: button.label },
          });
        }
      }
    }
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

const countPresentationDataBlocks = (blocks: readonly MessagePresentationBlock[]): number =>
  blocks.filter((block) => block.type === "table" || block.type === "chart").length;

/** Reads the Adaptive Card a resolved reply carries, if any. */
export const readMSTeamsPresentationCard = (payload: ReplyPayload) =>
  asOptionalRecord(asOptionalRecord(payload.channelData?.msteams)?.presentationCard);

/**
 * Resolve a reply's portable presentation into a Teams Adaptive Card, keeping both Teams
 * delivery paths on one rendering. Mirrors core's renderer, including degrading controls
 * to text rather than dropping them when Teams cannot carry them natively.
 */
export function prepareMSTeamsReplyPayload(payload: ReplyPayload): ReplyPayload {
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
  // Core's rule before its own renderer, applied so both Teams paths agree: once every
  // data block has degraded to text and nothing interactive remains, the producer's
  // authored fallback beats block flattening.
  if (
    textIsFallback &&
    payload.text?.trim() &&
    !presentation.blocks.some(isMessagePresentationInteractiveBlock) &&
    countPresentationDataBlocks(presentation.blocks) > 0 &&
    countPresentationDataBlocks(adapted.blocks) === 0
  ) {
    return rest;
  }
  const rendered = renderMSTeamsPresentationPayload({
    payload: textIsFallback ? { ...rest, text: undefined } : rest,
    presentation: adapted,
  });
  if (rendered) {
    return rendered;
  }
  return {
    ...rest,
    text: textIsFallback
      ? (payload.text ?? renderMessagePresentationFallbackText({ presentation }))
      : renderMessagePresentationFallbackText({ text: payload.text, presentation }),
  };
}
