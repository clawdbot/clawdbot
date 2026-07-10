// Telegram plugin module implements interactive fallback behavior.
import {
  interactiveReplyToPresentation,
  normalizeMessagePresentation,
  normalizeInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

/** Materialize unsupported charts before Telegram's local preview consumes the payload. */
export function materializeTelegramChartFallback(payload: ReplyPayload): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  const charts = presentation?.blocks.filter((block) => block.type === "chart") ?? [];
  if (!presentation || charts.length === 0) {
    return payload;
  }

  const chartText = renderMessagePresentationFallbackText({
    presentation: { ...presentation, blocks: charts },
  });
  const currentText = payload.text?.trim();
  const text = currentText?.includes(chartText)
    ? currentText
    : [currentText, chartText].filter(Boolean).join("\n\n");
  const remainingBlocks = presentation.blocks.filter((block) => block.type !== "chart");
  const materialized: ReplyPayload = { ...payload, text };
  if (remainingBlocks.length > 0) {
    // The title moved into text with the charts; retaining it on the remaining
    // presentation would render the same heading twice.
    const { title: _materializedTitle, ...remainingPresentation } = presentation;
    materialized.presentation = { ...remainingPresentation, blocks: remainingBlocks };
  } else {
    delete materialized.presentation;
  }
  return materialized;
}

export function resolveTelegramInteractiveTextFallback(params: {
  text?: string | null;
  interactive?: unknown;
  presentation?: unknown;
}): string | undefined {
  const interactive = normalizeInteractiveReply(params.interactive);
  const text = resolveInteractiveTextFallback({
    text: params.text ?? undefined,
    interactive,
  });
  if (text?.trim()) {
    return text;
  }
  const presentation = normalizeMessagePresentation(params.presentation);
  if (presentation) {
    const fallback = renderMessagePresentationFallbackText({
      text: params.text ?? undefined,
      presentation,
    });
    if (fallback.trim()) {
      return fallback;
    }
  }
  if (!interactive) {
    return text;
  }
  const interactivePresentation = interactiveReplyToPresentation(interactive);
  if (!interactivePresentation) {
    return text;
  }
  const fallback = renderMessagePresentationFallbackText({ presentation: interactivePresentation });
  return fallback.trim() ? fallback : text;
}
