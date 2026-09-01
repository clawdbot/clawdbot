// Telegram plugin module implements button types behavior.
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  legacyInteractiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  type AskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import {
  buildTelegramApprovalCallbackData,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
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
  buildTelegramQuestionCustomInputCallbackData,
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

export type TelegramDroppedControl = {
  label: string;
  reason:
    | "callback_data_too_long"
    | "invalid_action"
    | "question_context_unavailable"
    | "web_app_unavailable";
  callbackDataBytes?: number;
};

export type TelegramButtonBuildOptions = {
  allowWebAppButtons?: boolean;
  onDroppedControl?: (control: TelegramDroppedControl) => void;
  questionOptionIndices?: AskUserQuestionOptionIndices;
};

export function appendTelegramDroppedControlFallback(
  text: string,
  controls: readonly TelegramDroppedControl[],
): string {
  const fallback = renderMessagePresentationFallbackText({
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: controls.map((control) => ({ label: control.label, value: "unavailable" })),
        },
      ],
    },
  });
  if (!fallback || text === fallback || text.endsWith(`\n\n${fallback}`)) {
    return text;
  }
  return [text, fallback].filter(Boolean).join("\n\n");
}

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;

function toTelegramButtonStyle(
  style?: MessagePresentationButton["style"],
): TelegramInlineButton["style"] {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

function recordDroppedControl(
  button: MessagePresentationButton,
  options: TelegramButtonBuildOptions | undefined,
  reason: Exclude<TelegramDroppedControl["reason"], "callback_data_too_long">,
  callbackData?: string,
): undefined {
  const callbackDataBytes = callbackData ? Buffer.byteLength(callbackData, "utf8") : undefined;
  options?.onDroppedControl?.({
    label: button.label,
    reason:
      callbackDataBytes !== undefined && callbackDataBytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES
        ? "callback_data_too_long"
        : reason,
    ...(callbackDataBytes !== undefined ? { callbackDataBytes } : {}),
  });
  return undefined;
}

function toTelegramInlineButton(
  button: MessagePresentationButton,
  options?: TelegramButtonBuildOptions,
): TelegramInlineButton | undefined {
  const style = toTelegramButtonStyle(button.style);
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return recordDroppedControl(button, options, "invalid_action");
  }
  if (action.type === "url") {
    return { text: button.label, url: action.url, style };
  }
  if (action.type === "web-app") {
    return options?.allowWebAppButtons === true && action.url
      ? { text: button.label, web_app: { url: action.url }, style }
      : recordDroppedControl(button, options, "web_app_unavailable");
  }
  if (action.type === "approval") {
    const callbackData = buildTelegramApprovalCallbackData(action);
    return callbackData
      ? { text: button.label, callback_data: callbackData, style }
      : recordDroppedControl(button, options, "invalid_action");
  }
  if (action.type === "question") {
    const hasQuestionContext = options?.questionOptionIndices?.has(action.questionId) === true;
    if ("intent" in action) {
      const callbackData = hasQuestionContext
        ? buildTelegramQuestionCustomInputCallbackData(action.questionId)
        : undefined;
      return callbackData
        ? { text: button.label, callback_data: callbackData, style }
        : recordDroppedControl(button, options, "question_context_unavailable");
    }
    const optionIndex = resolveAskUserQuestionOptionIndex({
      questionOptionIndices: options?.questionOptionIndices,
      questionId: action.questionId,
      optionValue: action.optionValue,
    });
    if (optionIndex === undefined) {
      return recordDroppedControl(button, options, "question_context_unavailable");
    }
    const callbackData = buildTelegramQuestionCallbackData({
      questionId: action.questionId,
      optionIndex,
    });
    if (!callbackData) {
      return recordDroppedControl(button, options, "invalid_action");
    }
    // Presentation order is not authoritative; only Gateway-owned option order can choose an index.
    return { text: button.label, callback_data: callbackData, style };
  }
  if (action.type === "command") {
    const command = rewriteTelegramApprovalDecisionAlias(action.command.trim());
    const nativeCandidate = command ? buildTelegramNativeCommandCallbackData(command) : undefined;
    const nativeCallbackData = nativeCandidate
      ? sanitizeTelegramCallbackData(nativeCandidate)
      : undefined;
    // Historical approval commands may consume the full callback budget. Preserve
    // their authorized raw-command path when tgcmd: is the only overflow.
    const callbackData =
      nativeCallbackData ??
      (parseExecApprovalCommandText(command) ? sanitizeTelegramCallbackData(command) : undefined);
    return callbackData
      ? { text: button.label, callback_data: callbackData, style }
      : recordDroppedControl(button, options, "invalid_action", nativeCandidate);
  }
  // Reserve the full approval prefix, including malformed values, so legacy
  // plugin callbacks cannot be consumed by the approval handler.
  const normalizedCallbackValue = action.value.trim();
  const needsOpaqueEnvelope =
    Boolean(button.action) ||
    hasTelegramApprovalCallbackPrefix(normalizedCallbackValue) ||
    hasTelegramQuestionCallbackPrefix(normalizedCallbackValue);
  const callbackDataCandidate = needsOpaqueEnvelope
    ? buildTelegramOpaqueCallbackData(action.value)
    : action.value;
  const callbackData = sanitizeTelegramCallbackData(callbackDataCandidate);
  return callbackData
    ? { text: button.label, callback_data: callbackData, style }
    : recordDroppedControl(button, options, "invalid_action", callbackDataCandidate);
}

function chunkInteractiveButtons(
  buttons: readonly MessagePresentationButton[],
  rows: TelegramInlineButton[][],
  options?: TelegramButtonBuildOptions,
) {
  let row: TelegramInlineButton[] = [];
  const flush = () => {
    if (row.length > 0) {
      rows.push(row);
      row = [];
    }
  };
  for (const button of buttons) {
    const rendered = toTelegramInlineButton(button, options);
    if (!rendered) {
      continue;
    }
    if (resolveMessagePresentationButtonAction(button)?.type === "question") {
      flush();
      rows.push([rendered]);
      continue;
    }
    row.push(rendered);
    if (row.length === TELEGRAM_INTERACTIVE_ROW_SIZE) {
      flush();
    }
  }
  flush();
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
  if (params.buttons) {
    return params.buttons;
  }

  const interactive = normalizeLegacyInteractiveReply(params.interactive);
  return (
    buildTelegramPresentationButtons(
      interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined,
      options,
    ) ??
    buildTelegramPresentationButtons(normalizeMessagePresentation(params.presentation), options)
  );
}
