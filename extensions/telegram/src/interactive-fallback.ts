import {
  interactiveReplyToPresentation,
  normalizeInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";

export function resolveTelegramInteractiveTextFallback(params: {
  text?: string | null;
  interactive?: unknown;
}): string | undefined {
  const interactive = normalizeInteractiveReply(params.interactive);
  const text = resolveInteractiveTextFallback({
    text: params.text ?? undefined,
    interactive,
  });
  if (text?.trim()) {
    return text;
  }
  if (!interactive) {
    return text;
  }
  const presentation = interactiveReplyToPresentation(interactive);
  if (!presentation) {
    return text;
  }
  const fallback = renderMessagePresentationFallbackText({ presentation });
  return fallback.trim() ? fallback : text;
}
