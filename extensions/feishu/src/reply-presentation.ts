// Feishu plugin module resolves a reply's presentation into what Feishu sends.
import {
  adaptMessagePresentationForChannel,
  resolveLegacyInteractiveTextFallback,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "../runtime-api.js";
import {
  buildFeishuPresentationCard,
  FEISHU_PRESENTATION_CAPABILITIES,
  isFeishuCardWithinEnvelope,
  renderFeishuPresentationFallbackText,
  resolveFeishuRichReply,
} from "./presentation-card.js";

/**
 * What the reply path must send for a payload that offers controls.
 *
 * `card` carries the words and the controls in one native card, the way the
 * outbound send path already delivers them. `text` is the resolved prose for a
 * presentation Feishu cannot draw, so its labels stay visible.
 */
export type FeishuReplyPresentation =
  | { kind: "card"; card: Record<string, unknown>; content: string }
  | { kind: "text"; text: string };

function countDataBlocks(blocks: readonly MessagePresentationBlock[]): number {
  return blocks.filter((block) => block.type === "table" || block.type === "chart").length;
}

/**
 * Resolve a reply payload's presentation the way core resolves it for outbound
 * sends (`renderPresentationForDelivery`).
 *
 * Core runs that resolution inside the outbound send pipeline only, so replies
 * this plugin delivers itself reach delivery with their controls still
 * portable. Returns undefined when the payload carries no presentation, leaving
 * every ordinary reply on its existing path.
 */
export function resolveFeishuReplyPresentation(
  payload: ReplyPayload,
): FeishuReplyPresentation | undefined {
  const { interactive, presentation } = resolveFeishuRichReply(payload);
  if (!presentation) {
    return undefined;
  }
  const adapted = adaptMessagePresentationForChannel({
    presentation,
    capabilities: FEISHU_PRESENTATION_CAPABILITIES,
  });
  const textIsFallback = payload.presentationTextMode === "fallback";
  const authoredText = payload.text;
  const hasInteractiveBlocks = presentation.blocks.some(
    (block) => block.type === "buttons" || block.type === "select",
  );
  // Core's rule: when every structured data block degraded to text and nothing
  // interactive remains, the producer's authored fallback beats generic block
  // flattening, so that text survives verbatim instead of being rebuilt.
  if (
    textIsFallback &&
    authoredText?.trim() &&
    !hasInteractiveBlocks &&
    countDataBlocks(presentation.blocks) > 0 &&
    countDataBlocks(adapted.blocks) === 0
  ) {
    return { kind: "text", text: authoredText };
  }
  const card = buildFeishuPresentationCard({
    presentation: adapted,
    // Fallback text is the prose rendering of these same blocks; carrying it
    // into the card would print every block twice.
    ...(textIsFallback
      ? {}
      : {
          fallbackText: resolveLegacyInteractiveTextFallback({
            text: authoredText,
            interactive,
          }),
        }),
  });
  if (isFeishuCardWithinEnvelope(card)) {
    return {
      kind: "card",
      card,
      // The transcript keeps the words the card shows, not the card JSON.
      content: renderFeishuPresentationFallbackText(
        {
          ...(textIsFallback ? {} : { text: authoredText }),
          presentation: adapted,
        },
        "markdown",
      ),
    };
  }
  // A card Feishu would reject still has to deliver the labels it carried.
  return {
    kind: "text",
    text: textIsFallback
      ? (authoredText ?? renderFeishuPresentationFallbackText({ presentation }, "markdown"))
      : renderFeishuPresentationFallbackText({ text: authoredText, presentation }, "markdown"),
  };
}
