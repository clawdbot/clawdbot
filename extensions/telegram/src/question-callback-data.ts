// Telegram-private ask_user callback envelope.
import { fitsTelegramCallbackData } from "./approval-callback-data.js";

const TELEGRAM_QUESTION_CALLBACK_PREFIXES = ["tgq1:", "tgqo1:"] as const;
const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type TelegramQuestionCallback =
  | { questionId: string; intent: "select"; optionIndex: number }
  | { questionId: string; intent: "custom-input" };

export function hasTelegramQuestionCallbackPrefix(data?: string | null): boolean {
  return TELEGRAM_QUESTION_CALLBACK_PREFIXES.some((prefix) => data?.startsWith(prefix) === true);
}

export function buildTelegramQuestionCallbackData(
  callback:
    | Extract<TelegramQuestionCallback, { intent: "select" }>
    | {
        questionId: string;
        optionIndex: number;
      },
): string | undefined {
  if (
    !QUESTION_RECORD_ID_PATTERN.test(callback.questionId) ||
    !Number.isInteger(callback.optionIndex) ||
    callback.optionIndex < 0 ||
    callback.optionIndex > 3
  ) {
    return undefined;
  }
  const data = `tgq1:${callback.questionId}:${callback.optionIndex}`;
  return fitsTelegramCallbackData(data) ? data : undefined;
}

export function buildTelegramQuestionCustomInputCallbackData(
  questionId: string,
): string | undefined {
  if (!QUESTION_RECORD_ID_PATTERN.test(questionId)) {
    return undefined;
  }
  const data = `tgqo1:${questionId}`;
  return fitsTelegramCallbackData(data) ? data : undefined;
}

export function parseTelegramQuestionCallbackData(
  data?: string | null,
): TelegramQuestionCallback | null {
  if (!hasTelegramQuestionCallbackPrefix(data) || !data || !fitsTelegramCallbackData(data)) {
    return null;
  }
  const selectMatch = /^tgq1:(ask_[a-f0-9]{32}):([0-3])$/u.exec(data);
  if (selectMatch?.[1] && selectMatch[2]) {
    return { questionId: selectMatch[1], intent: "select", optionIndex: Number(selectMatch[2]) };
  }
  const customInputMatch = /^tgqo1:(ask_[a-f0-9]{32})$/u.exec(data);
  return customInputMatch?.[1] ? { questionId: customInputMatch[1], intent: "custom-input" } : null;
}
