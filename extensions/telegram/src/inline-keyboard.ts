import type { InlineKeyboardButton, InlineKeyboardMarkup } from "@grammyjs/types";
import type { TelegramInlineButtons } from "./button-types.js";

export function buildInlineKeyboard(
  buttons?: TelegramInlineButtons,
): InlineKeyboardMarkup | undefined {
  if (!buttons?.length) {
    return undefined;
  }
  const rows = buttons
    .map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map(
          (button): InlineKeyboardButton => ({
            text: button.text,
            callback_data: button.callback_data,
            ...(button.style ? { style: button.style } : {}),
          }),
        ),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return undefined;
  }
  return { inline_keyboard: rows };
}
