// Msteams plugin module implements presentation behavior.
import {
  adaptMessagePresentationForChannel,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
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
 * Attach the Adaptive Card for an adapted presentation, or null when Teams cannot
 * carry one. A card and a media attachment cannot share one activity, so a reply
 * with media keeps its media and the caller degrades the controls to text.
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

/** Reads the Adaptive Card a prepared reply carries, if any. */
export function readMSTeamsPresentationCard(
  payload: ReplyPayload,
): Record<string, unknown> | undefined {
  const card = asOptionalRecord(payload.channelData?.msteams)?.presentationCard;
  return asOptionalRecord(card);
}

/**
 * Resolve a reply's portable presentation into a Teams Adaptive Card.
 *
 * Core renders presentations inside the outbound send pipeline only, so replies the
 * monitor delivers itself arrive with the controls still portable. Preparing them here
 * keeps both Teams delivery paths on one rendering, and mirrors what core's renderer
 * does when a channel cannot carry the controls natively: degrade them to text rather
 * than drop them.
 */
export function prepareMSTeamsReplyPayload(payload: ReplyPayload): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const { presentation: _presentation, presentationTextMode, ...rest } = payload;
  // "fallback" text already renders these controls as prose; the card replaces it.
  const textIsFallback = presentationTextMode === "fallback";
  const rendered = renderMSTeamsPresentationPayload({
    payload: textIsFallback ? { ...rest, text: undefined } : rest,
    presentation: adaptMessagePresentationForChannel({
      presentation,
      capabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
    }),
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
