import {
  interactiveReplyToPresentation,
  normalizeMessagePresentation,
  normalizeInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";

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
