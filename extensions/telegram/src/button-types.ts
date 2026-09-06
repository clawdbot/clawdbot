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
  copy_text?: { text: string };
  url?: string;
  web_app?: { url: string };
  style?: TelegramButtonStyle;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

export type TelegramDroppedControl = {
  label: string;
  reason:
    | "callback_data_too_long"
    | "copy_text_invalid"
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
const TELEGRAM_COPY_TEXT_MAX_CHARACTERS = 256;

/** Whether TDLib will store the exact authored scalar sequence without rewriting it. */
export function isValidTelegramCopyText(text: string): boolean {
  let characterCount = 0;
  let normalized = "";
  for (let index = 0; index < text.length;) {
    const firstUnit = text.charCodeAt(index);
    let character: string;
    let codePoint: number;
    if (firstUnit >= 0xd800 && firstUnit <= 0xdbff) {
      if (index + 1 >= text.length) {
        return false;
      }
      const secondUnit = text.charCodeAt(index + 1);
      if (secondUnit < 0xdc00 || secondUnit > 0xdfff) {
        return false;
      }
      character = text.slice(index, index + 2);
      codePoint = 0x10000 + ((firstUnit - 0xd800) << 10) + (secondUnit - 0xdc00);
      index += 2;
    } else {
      if (firstUnit >= 0xdc00 && firstUnit <= 0xdfff) {
        return false;
      }
      character = text[index] ?? "";
      codePoint = firstUnit;
      index += 1;
    }
    characterCount += 1;
    if (characterCount > TELEGRAM_COPY_TEXT_MAX_CHARACTERS) {
      return false;
    }

    // Mirror TDLib clean_input_string so native copy_text is byte/character stable.
    if (codePoint === 0x0d || (codePoint >= 0x2028 && codePoint <= 0x202e)) {
      continue;
    }
    if (codePoint === 0x030a || codePoint === 0x0333 || codePoint === 0x033f) {
      continue;
    }
    normalized +=
      (codePoint >= 0x00 && codePoint <= 0x09) ||
      (codePoint >= 0x0b && codePoint <= 0x0c) ||
      (codePoint >= 0x0e && codePoint <= 0x20)
        ? " "
        : character;
  }
  if (characterCount === 0) {
    return false;
  }
  normalized = normalized.replace(/[\u200e\u200f](?=[\u200e\u200f])/gu, "\u200c");
  return normalized === text;
}

function escapedCodeUnit(codeUnit: number): string {
  return `\\u${codeUnit.toString(16).padStart(4, "0")}`;
}

/** Render units TDLib rewrites or rejects as an inspectable manual-copy value. */
export function escapeTelegramCopyTextFallback(text: string): string {
  let escaped = "";
  for (let index = 0; index < text.length;) {
    const firstUnit = text.charCodeAt(index);
    if (firstUnit >= 0xd800 && firstUnit <= 0xdbff) {
      const secondUnit = text.charCodeAt(index + 1);
      if (secondUnit >= 0xdc00 && secondUnit <= 0xdfff) {
        escaped += text.slice(index, index + 2);
        index += 2;
        continue;
      }
      escaped += escapedCodeUnit(firstUnit);
      index += 1;
      continue;
    }
    if (firstUnit >= 0xdc00 && firstUnit <= 0xdfff) {
      escaped += escapedCodeUnit(firstUnit);
      index += 1;
      continue;
    }

    if (firstUnit === 0x00) {
      escaped += "\\0";
    } else if (firstUnit === 0x09) {
      escaped += "\\t";
    } else if (firstUnit === 0x0b) {
      escaped += "\\v";
    } else if (firstUnit === 0x0c) {
      escaped += "\\f";
    } else if (firstUnit === 0x0d) {
      escaped += "\\r";
    } else if (
      (firstUnit >= 0x01 && firstUnit <= 0x08) ||
      (firstUnit >= 0x0e && firstUnit <= 0x1f) ||
      (firstUnit >= 0x2028 && firstUnit <= 0x202e) ||
      firstUnit === 0x030a ||
      firstUnit === 0x0333 ||
      firstUnit === 0x033f ||
      firstUnit === 0x200e ||
      firstUnit === 0x200f
    ) {
      escaped += escapedCodeUnit(firstUnit);
    } else {
      escaped += text[index] ?? "";
    }
    index += 1;
  }
  return escaped;
}

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
  if (action.type === "copy-text") {
    return isValidTelegramCopyText(action.text)
      ? { text: button.label, copy_text: { text: action.text }, style }
      : recordDroppedControl(button, options, "copy_text_invalid");
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
  if (action.type !== "callback") {
    return recordDroppedControl(button, options, "invalid_action");
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
