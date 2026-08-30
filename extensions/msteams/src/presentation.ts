// Msteams plugin module implements presentation behavior.
import {
  adaptMessagePresentationForChannel,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ChannelOutboundAdapter } from "../runtime-api.js";

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

/** How a reply's presentation reaches Teams once the channel has resolved it. */
export type MSTeamsReplyPresentation =
  | { kind: "card"; card: Record<string, unknown> }
  | { kind: "text"; text: string };

const countMSTeamsPresentationDataBlocks = (blocks: readonly MessagePresentationBlock[]): number =>
  blocks.filter((block) => block.type === "table" || block.type === "chart").length;

/**
 * Resolve a reply's portable presentation for the monitor's own send path.
 *
 * Core runs the presentation renderer inside the outbound send pipeline only, so a
 * reply the monitor delivers itself reaches Teams with its presentation still
 * portable — and loses it. Resolving it here puts both Teams delivery paths on the
 * one card builder, and mirrors `renderPresentationForDelivery`, which owns the same
 * decision for the outbound path.
 */
export function resolveMSTeamsReplyPresentation(
  payload: ReplyPayload,
): MSTeamsReplyPresentation | undefined {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return undefined;
  }
  const usesFallbackText = payload.presentationTextMode === "fallback";
  const adapted = adaptMessagePresentationForChannel({
    presentation,
    capabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
  });
  // Only a presentation whose structured blocks all degraded to text says nothing its
  // producer's own fallback prose already says; that prose then stays verbatim.
  const degradedToTextOnly =
    !presentation.blocks.some((block) => block.type === "buttons" || block.type === "select") &&
    countMSTeamsPresentationDataBlocks(presentation.blocks) > 0 &&
    countMSTeamsPresentationDataBlocks(adapted.blocks) === 0;
  if (usesFallbackText && payload.text?.trim() && degradedToTextOnly) {
    return { kind: "text", text: payload.text };
  }
  // A Teams activity carries a card or an attachment, never both, so a reply that also
  // carries media keeps its media and states the controls in prose instead.
  if (resolveOutboundMediaUrls(payload).length === 0) {
    return {
      kind: "card",
      // The card renders the authored prose itself; passing it again would repeat it.
      card: buildMSTeamsPresentationCard({
        presentation,
        text: usesFallbackText ? undefined : payload.text,
      }),
    };
  }
  return {
    kind: "text",
    text: usesFallbackText
      ? (payload.text ?? renderMessagePresentationFallbackText({ presentation }))
      : renderMessagePresentationFallbackText({ text: payload.text, presentation }),
  };
}
