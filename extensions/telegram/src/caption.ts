// Telegram plugin module implements caption behavior.
import { countTelegramHtmlVisibleCharacters, resolveTelegramHtmlVisibleText } from "./format.js";

const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

export function splitTelegramCaption(
  text?: string,
  renderedHtml?: string,
): {
  caption?: string;
  followUpText?: string;
} {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return { caption: undefined, followUpText: undefined };
  }
  const visibleLength =
    renderedHtml === undefined ? trimmed.length : countTelegramHtmlVisibleCharacters(renderedHtml);
  if (visibleLength > TELEGRAM_MAX_CAPTION_LENGTH) {
    return { caption: undefined, followUpText: trimmed };
  }
  return { caption: trimmed, followUpText: undefined };
}

export function resolveTelegramPlainCaption(
  caption: string | undefined,
  renderedHtml: string | undefined,
): string | undefined {
  if (
    caption === undefined ||
    caption.length <= TELEGRAM_MAX_CAPTION_LENGTH ||
    renderedHtml === undefined
  ) {
    return caption;
  }
  // A markup-heavy source can fit only after parsing; its plain retry must fit too.
  return resolveTelegramHtmlVisibleText(renderedHtml);
}
