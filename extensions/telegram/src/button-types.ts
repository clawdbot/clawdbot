// Telegram plugin module implements button types behavior.
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { reduceLegacyInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import {
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  resolveMessagePresentationButtonAction,
  type LegacyInteractiveReply,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  buildTelegramApprovalCallbackData,
  hasTelegramApprovalCallbackPrefix,
  rewriteTelegramApprovalDecisionAlias,
  sanitizeTelegramCallbackData,
} from "./approval-callback-data.js";
import {
  buildTelegramNativeCommandCallbackData,
  buildTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import {
  buildTelegramQuestionCallbackData,
  hasTelegramQuestionCallbackPrefix,
} from "./question-callback-data.js";

export type TelegramButtonStyle = "danger" | "success" | "primary";

type TelegramInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  style?: TelegramButtonStyle;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

type TelegramQuestionOptionIndices = ReadonlyMap<string, ReadonlyMap<string, number>>;

export type TelegramButtonBuildOptions = {
  allowWebAppButtons?: boolean;
  questionOptionIndices?: TelegramQuestionOptionIndices;
};

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;

/** Reads only bounded, unambiguous Gateway-owned question option ordering. */
export function resolveTelegramQuestionOptionIndices(
  payload: Pick<ReplyPayload, "channelData">,
): TelegramQuestionOptionIndices | undefined {
  const askUser = payload.channelData?.askUser;
  if (!askUser || typeof askUser !== "object" || Array.isArray(askUser)) {
    return undefined;
  }
  const { questionId, optionValues } = askUser as {
    questionId?: unknown;
    optionValues?: unknown;
  };
  if (
    typeof questionId !== "string" ||
    !questionId ||
    !Array.isArray(optionValues) ||
    optionValues.length < 2 ||
    optionValues.length > 4
  ) {
    return undefined;
  }

  const optionIndices = new Map<string, number>();
  for (const [optionIndex, optionValue] of optionValues.entries()) {
    if (typeof optionValue !== "string") {
      return undefined;
    }
    const normalizedOptionValue = optionValue.trim().toLowerCase();
    if (!normalizedOptionValue || optionIndices.has(normalizedOptionValue)) {
      return undefined;
    }
    optionIndices.set(normalizedOptionValue, optionIndex);
  }
  return new Map([[questionId, optionIndices]]);
}

function toTelegramButtonStyle(
  style?: MessagePresentationButton["style"],
): TelegramInlineButton["style"] {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

function toTelegramInlineButton(
  button: MessagePresentationButton,
  options?: TelegramButtonBuildOptions,
): TelegramInlineButton | undefined {
  const style = toTelegramButtonStyle(button.style);
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return undefined;
  }
  if (action.type === "url") {
    return { text: button.label, url: action.url, style };
  }
  if (action.type === "web-app") {
    return options?.allowWebAppButtons === true && action.url
      ? { text: button.label, web_app: { url: action.url }, style }
      : undefined;
  }
  if (action.type === "approval") {
    const callbackData = buildTelegramApprovalCallbackData(action);
    return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
  }
  if (action.type === "question") {
    const normalizedOptionValue = action.optionValue.trim().toLowerCase();
    const optionIndex = options?.questionOptionIndices
      ?.get(action.questionId)
      ?.get(normalizedOptionValue);
    if (optionIndex === undefined) {
      return undefined;
    }
    const callbackData = buildTelegramQuestionCallbackData({
      questionId: action.questionId,
      optionIndex,
    });
    if (!callbackData) {
      return undefined;
    }
    // Presentation order is not authoritative; only Gateway-owned option order can choose an index.
    return { text: button.label, callback_data: callbackData, style };
  }
  if (action.type === "command") {
    const command = rewriteTelegramApprovalDecisionAlias(action.command.trim());
    const nativeCallbackData = command
      ? sanitizeTelegramCallbackData(buildTelegramNativeCommandCallbackData(command))
      : undefined;
    // Historical approval commands may consume the full callback budget. Preserve
    // their authorized raw-command path when tgcmd: is the only overflow.
    const callbackData =
      nativeCallbackData ??
      (parseExecApprovalCommandText(command) ? sanitizeTelegramCallbackData(command) : undefined);
    return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
  }
  // Reserve the full approval prefix, including malformed values, so legacy
  // plugin callbacks cannot be consumed by the approval handler.
  const normalizedCallbackValue = action.value.trim();
  const needsOpaqueEnvelope =
    Boolean(button.action) ||
    hasTelegramApprovalCallbackPrefix(normalizedCallbackValue) ||
    hasTelegramQuestionCallbackPrefix(normalizedCallbackValue);
  const callbackData = sanitizeTelegramCallbackData(
    needsOpaqueEnvelope ? buildTelegramOpaqueCallbackData(action.value) : action.value,
  );
  return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
}

function chunkInteractiveButtons(
  buttons: readonly MessagePresentationButton[],
  rows: TelegramInlineButton[][],
  options?: TelegramButtonBuildOptions,
) {
  for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
    const row = buttons
      .slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE)
      .map((button) => toTelegramInlineButton(button, options))
      .filter((button): button is TelegramInlineButton => Boolean(button));
    if (row.length > 0) {
      rows.push(row);
    }
  }
}

/**
 * @deprecated Use buildTelegramPresentationButtons with MessagePresentation.
 */
function buildTelegramInteractiveButtons(
  interactive?: LegacyInteractiveReply,
  options?: TelegramButtonBuildOptions,
): TelegramInlineButtons | undefined {
  const rows = reduceLegacyInteractiveReply(
    interactive,
    [] as TelegramInlineButton[][],
    (state, block) => {
      if (block.type === "buttons") {
        chunkInteractiveButtons(block.buttons, state, options);
        return state;
      }
      if (block.type === "select") {
        chunkInteractiveButtons(
          block.options.map((option) => ({
            label: option.label,
            action: option.action,
            value: option.value,
          })),
          state,
          options,
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
  options?: TelegramButtonBuildOptions,
): TelegramInlineButtons | undefined {
  const rows: TelegramInlineButton[][] = [];
  for (const block of presentation?.blocks ?? []) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      continue;
    }
    if (block.type === "buttons") {
      chunkInteractiveButtons(block.buttons, rows, options);
      continue;
    }
    chunkInteractiveButtons(
      block.options.map((option) => ({
        label: option.label,
        action: option.action,
        value: option.value,
      })),
      rows,
      options,
    );
  }
  return rows.length > 0 ? rows : undefined;
}

/** Resolve Telegram inline buttons, preserving explicit and legacy button precedence. */
export function resolveTelegramInlineButtons(
  params: {
    buttons?: TelegramInlineButtons;
    presentation?: unknown;
    interactive?: unknown;
  },
  options?: TelegramButtonBuildOptions,
): TelegramInlineButtons | undefined {
  return (
    params.buttons ??
    buildTelegramInteractiveButtons(normalizeLegacyInteractiveReply(params.interactive), options) ??
    buildTelegramPresentationButtons(normalizeMessagePresentation(params.presentation), options)
  );
}
