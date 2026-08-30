const TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE = Symbol.for(
  "openclaw.telegram.callbackQueryAnswerPromise",
);
// Durable admission precedes bot middleware. Keep only new-row answers until
// that same bot consumes them; the WeakMap releases all state with the bot.
const telegramCallbackQueryAdmissionAnswers = new WeakMap<object, Map<string, Promise<unknown>>>();

export function recordTelegramCallbackQueryAdmissionAnswer(
  bot: object,
  callbackQueryId: string,
  promise: Promise<unknown>,
): void {
  const existingAnswers = telegramCallbackQueryAdmissionAnswers.get(bot);
  const answers = existingAnswers ?? new Map<string, Promise<unknown>>();
  if (!existingAnswers) {
    telegramCallbackQueryAdmissionAnswers.set(bot, answers);
  }
  answers.set(callbackQueryId, promise);
  void promise.catch(() => {
    if (answers.get(callbackQueryId) === promise) {
      answers.delete(callbackQueryId);
    }
  });
}

export function getTelegramCallbackQueryAdmissionAnswer(
  bot: object,
  callbackQueryId: string,
): Promise<unknown> | undefined {
  return telegramCallbackQueryAdmissionAnswers.get(bot)?.get(callbackQueryId);
}

export function takeTelegramCallbackQueryAdmissionAnswer(
  bot: object,
  callbackQueryId: string,
): Promise<unknown> | undefined {
  const answers = telegramCallbackQueryAdmissionAnswers.get(bot);
  const promise = answers?.get(callbackQueryId);
  answers?.delete(callbackQueryId);
  return promise;
}

export function setTelegramCallbackQueryAnswerPromise(
  ctx: object,
  promise: Promise<unknown>,
): void {
  Object.defineProperty(ctx, TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE, {
    configurable: true,
    value: promise,
  });
}

export function getTelegramCallbackQueryAnswerPromise(ctx: object): Promise<unknown> | undefined {
  const promise = (ctx as Record<PropertyKey, unknown>)[TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE];
  return promise instanceof Promise ? promise : undefined;
}
