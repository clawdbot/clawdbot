import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import {
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeInteractiveReply,
  type InteractiveReply,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { sanitizeTelegramCallbackData } from "./approval-callback-data.js";
import {
  buildTelegramNativeCommandCallbackData,
  buildTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";

export type TelegramButtonStyle = "danger" | "success" | "primary";

type TelegramInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  style?: TelegramButtonStyle;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;

function toTelegramButtonStyle(
  style?: MessagePresentationButton["style"],
): TelegramInlineButton["style"] {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

function toTelegramInlineButton(
  button: MessagePresentationButton,
): TelegramInlineButton | undefined {
  const style = toTelegramButtonStyle(button.style);
  if (button.url) {
    return {
      text: button.label,
      url: button.url,
      style,
    };
  }
  const callbackData = toTelegramCallbackData(button);
  if (callbackData) {
    return {
      text: button.label,
      callback_data: callbackData,
      style,
    };
  }
  if (button.webApp?.url) {
    return {
      text: button.label,
      web_app: { url: button.webApp.url },
      style,
    };
  }
  return undefined;
}

function toTelegramCallbackData(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "command") {
    const command = button.action.command.trim();
    if (!command) {
      return undefined;
    }
    if (parseExecApprovalCommandText(command)) {
      return sanitizeTelegramCallbackData(command);
    }
    const callbackData = buildTelegramNativeCommandCallbackData(command);
    return sanitizeTelegramCallbackData(callbackData);
  }
  if (button.action?.type === "callback") {
    return sanitizeTelegramCallbackData(buildTelegramOpaqueCallbackData(button.action.value));
  }
  return button.value ? sanitizeTelegramCallbackData(button.value) : undefined;
}

function chunkInteractiveButtons(
  buttons: readonly MessagePresentationButton[],
  rows: TelegramInlineButton[][],
) {
  for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
    const row = buttons
      .slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE)
      .map(toTelegramInlineButton)
      .filter((button): button is TelegramInlineButton => Boolean(button));
    if (row.length > 0) {
      rows.push(row);
    }
  }
}

/**
 * @deprecated Use buildTelegramPresentationButtons with MessagePresentation.
 */
export function buildTelegramInteractiveButtons(
  interactive?: InteractiveReply,
): TelegramInlineButtons | undefined {
  const rows = reduceInteractiveReply(
    interactive,
    [] as TelegramInlineButton[][],
    (state, block) => {
      if (block.type === "buttons") {
        chunkInteractiveButtons(block.buttons, state);
        return state;
      }
      if (block.type === "select") {
        chunkInteractiveButtons(
          block.options.map((option) => ({
            label: option.label,
            value: option.value,
          })),
          state,
        );
      }
      return state;
    },
  );
  return rows.length > 0 ? rows : undefined;
}

/** Convert portable presentation controls to Telegram inline keyboard rows. */
export function buildTelegramPresentationButtons(
  presentation?: MessagePresentation,
): TelegramInlineButtons | undefined {
  const rows: TelegramInlineButton[][] = [];
  for (const block of presentation?.blocks ?? []) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      continue;
    }
    if (block.type === "buttons") {
      chunkInteractiveButtons(block.buttons, rows);
      continue;
    }
    chunkInteractiveButtons(
      block.options.map((option) => ({
        label: option.label,
        action: option.action,
        value: option.value,
      })),
      rows,
    );
  }
  return rows.length > 0 ? rows : undefined;
}

/** Resolve Telegram inline buttons, preserving explicit and legacy button precedence. */
export function resolveTelegramInlineButtons(params: {
  buttons?: TelegramInlineButtons;
  presentation?: unknown;
  interactive?: unknown;
}): TelegramInlineButtons | undefined {
  return (
    params.buttons ??
    buildTelegramInteractiveButtons(normalizeInteractiveReply(params.interactive)) ??
    buildTelegramPresentationButtons(normalizeMessagePresentation(params.presentation))
  );
}
