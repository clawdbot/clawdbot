import { TELEGRAM_GENERAL_TOPIC_ID, type TelegramThreadSpec } from "./bot/helpers.js";

type TelegramThreadMessage = {
  message_id?: number;
  message_thread_id?: number;
  chat?: { type?: string };
};

export function resolveTelegramProviderObservedThreadId(params: {
  message: TelegramThreadMessage;
  successfulSendThread?: TelegramThreadSpec;
}): number | undefined {
  if (typeof params.message.message_thread_id === "number") {
    return params.message.message_thread_id;
  }
  return params.message.chat?.type === "supergroup" &&
    params.successfulSendThread?.scope === "forum" &&
    params.successfulSendThread.id === TELEGRAM_GENERAL_TOPIC_ID
    ? TELEGRAM_GENERAL_TOPIC_ID
    : undefined;
}

export function assertTelegramProviderThread(params: {
  message: TelegramThreadMessage;
  successfulSendThread?: TelegramThreadSpec;
}): void {
  const expectedThreadId = params.successfulSendThread?.id;
  if (expectedThreadId === undefined) {
    return;
  }
  const providerThreadId = resolveTelegramProviderObservedThreadId(params);
  if (providerThreadId !== expectedThreadId) {
    throw new Error(
      `Telegram delivered message ${params.message.message_id ?? "unknown"} to topic ${providerThreadId ?? "unknown"}; expected topic ${expectedThreadId}`,
    );
  }
}
