import type { ReplyPayload } from "../../../auto-reply/types.js";
import {
  type MessagePresentation,
  type MessagePresentationBlock,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../../interactive/payload.js";
import type { ChannelPresentationCapabilities } from "../outbound.types.js";
import { adaptMessagePresentationForChannel } from "./presentation-limits.js";

/** Apply the same native rendering and fallback policy to every channel delivery path. */
export async function renderPresentationForDelivery(
  handler: {
    presentationCapabilities?: ChannelPresentationCapabilities;
    renderPresentation?: (
      payload: ReplyPayload & { presentation: MessagePresentation },
    ) => ReplyPayload | null | Promise<ReplyPayload | null>;
  },
  payload: ReplyPayload,
): Promise<ReplyPayload> {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const adaptedPresentation = adaptMessagePresentationForChannel({
    presentation,
    capabilities: handler.presentationCapabilities,
  });
  const textIsFallback = payload.presentationTextMode === "fallback";
  const countDataBlocks = (blocks: readonly MessagePresentationBlock[]) =>
    blocks.filter((block) => block.type === "table" || block.type === "chart").length;
  const hasInteractiveBlocks = presentation.blocks.some(
    (block) => block.type === "buttons" || block.type === "select",
  );
  // When every structured data block degraded to text and nothing interactive
  // remains, the producer's authored fallback text beats generic block
  // flattening; skip the channel renderer so that text survives verbatim.
  if (
    textIsFallback &&
    payload.text?.trim() &&
    !hasInteractiveBlocks &&
    countDataBlocks(presentation.blocks) > 0 &&
    countDataBlocks(adaptedPresentation.blocks) === 0
  ) {
    const {
      presentation: _degradedPresentation,
      presentationTextMode: _degradedPresentationTextMode,
      ...authoredFallback
    } = payload;
    return authoredFallback;
  }
  const adaptedPayload = {
    ...payload,
    ...(textIsFallback ? { text: undefined } : {}),
    presentation: adaptedPresentation,
  };
  const rendered = handler.renderPresentation
    ? await handler.renderPresentation(adaptedPayload)
    : null;
  if (rendered) {
    const {
      presentation: _presentation,
      presentationTextMode: _presentationTextMode,
      ...withoutPresentation
    } = rendered;
    return withoutPresentation;
  }
  const {
    presentation: _presentation,
    presentationTextMode: _presentationTextMode,
    ...withoutPresentation
  } = payload;
  // Native controls may be clipped or split; plain fallback must retain authored labels.
  return {
    ...withoutPresentation,
    text: textIsFallback
      ? (payload.text ?? renderMessagePresentationFallbackText({ presentation }))
      : renderMessagePresentationFallbackText({
          text: payload.text,
          presentation,
        }),
  };
}
