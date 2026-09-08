// Mattermost helper module supports normalize behavior.
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationControlValue,
} from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveMattermostPresentation(params: {
  text?: string;
  presentation?: unknown;
  presentationTextMode?: "fallback";
}) {
  const presentation = normalizeMessagePresentation(params.presentation);
  const text =
    !presentation || (params.presentationTextMode === "fallback" && params.text !== undefined)
      ? (params.text ?? "")
      : renderMessagePresentationFallbackText({ text: params.text, presentation });
  const buttons = presentation
    ? presentation.blocks
        .filter((block) => block.type === "buttons")
        .map((block) =>
          block.buttons.flatMap((button) => {
            if (button.action) {
              return [];
            }
            const value = resolveMessagePresentationControlValue(button);
            return value
              ? [
                  {
                    id: value,
                    text: button.label,
                    callback_data: value,
                    context: { callback_data: value },
                    style: button.style,
                  },
                ]
              : [];
          }),
        )
        .filter((row) => row.length > 0)
    : [];
  return { text, buttons };
}

export function normalizeMattermostMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (lower.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("mattermost:")) {
    const id = trimmed.slice("mattermost:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `@${id}` : undefined;
  }
  if (trimmed.startsWith("#")) {
    // Strip # prefix and fall through to directory lookup (same as bare names).
    // The core's resolveMessagingTarget will use the directory adapter to
    // resolve the channel name to its Mattermost ID.
    return undefined;
  }
  // Bare name without prefix — return undefined to allow directory lookup
  return undefined;
}

/**
 * True when media must be uploaded as a file: any non-empty, non-http(s) value
 * (e.g. a local workspace path) has no address the server can fetch, so the
 * send must require a successful upload rather than degrade to caption text.
 */
export function requiresMattermostMediaUpload(mediaUrl: string | undefined): boolean {
  const trimmed = mediaUrl?.trim();
  return Boolean(trimmed && !/^https?:\/\//i.test(trimmed));
}

export function looksLikeMattermostTargetId(raw: string, _normalized?: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(user|channel|group|mattermost):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith("@")) {
    return true;
  }
  // Mattermost IDs: 26-char alnum, or DM channels like "abc123__xyz789" (53 chars)
  return /^[a-z0-9]{26}$/i.test(trimmed) || /^[a-z0-9]{26}__[a-z0-9]{26}$/i.test(trimmed);
}
