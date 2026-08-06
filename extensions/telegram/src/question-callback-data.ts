// Telegram-private ask_user callback envelope.
const TELEGRAM_QUESTION_CALLBACK_PREFIX = "tgq1:";
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type TelegramQuestionCallback = {
  questionId: string;
  optionIndex: number;
};

export function hasTelegramQuestionCallbackPrefix(data?: string | null): boolean {
  return data?.startsWith(TELEGRAM_QUESTION_CALLBACK_PREFIX) === true;
}

export function buildTelegramQuestionCallbackData(
  callback: TelegramQuestionCallback,
): string | undefined {
  if (
    !QUESTION_RECORD_ID_PATTERN.test(callback.questionId) ||
    !Number.isInteger(callback.optionIndex) ||
    callback.optionIndex < 0 ||
    callback.optionIndex > 3
  ) {
    return undefined;
  }
  const data = `${TELEGRAM_QUESTION_CALLBACK_PREFIX}${callback.questionId}:${callback.optionIndex}`;
  return Buffer.byteLength(data, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES ? data : undefined;
}

export function parseTelegramQuestionCallbackData(
  data?: string | null,
): TelegramQuestionCallback | null {
  if (
    !hasTelegramQuestionCallbackPrefix(data) ||
    !data ||
    Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES
  ) {
    return null;
  }
  const match = /^tgq1:(ask_[a-f0-9]{32}):([0-3])$/u.exec(data);
  return match?.[1] && match[2] ? { questionId: match[1], optionIndex: Number(match[2]) } : null;
}
