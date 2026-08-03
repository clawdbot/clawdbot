const TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE = Symbol.for(
  "openclaw.telegram.callbackQueryAnswerPromise",
);

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
