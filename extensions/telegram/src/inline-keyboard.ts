import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@grammyjs/types";
import type { TelegramInlineButtons } from "./button-types.js";

function toInlineKeyboardButton(
  button: TelegramInlineButtons[number][number] | undefined,
): InlineKeyboardButton | undefined {
  if (!button?.text) {
    return undefined;
  }
  if (button.url) {
    return button.style
      ? { text: button.text, url: button.url, style: button.style }
      : { text: button.text, url: button.url };
  }
  if (button.callback_data) {
    return button.style
      ? { text: button.text, callback_data: button.callback_data, style: button.style }
      : { text: button.text, callback_data: button.callback_data };
  }
  return undefined;
}

export function buildInlineKeyboard(
  buttons?: TelegramInlineButtons,
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row
        .map(toInlineKeyboardButton)
        .filter((button): button is InlineKeyboardButton => Boolean(button)),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}
