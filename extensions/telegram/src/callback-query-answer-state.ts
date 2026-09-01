const TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE = Symbol.for(
  "openclaw.telegram.callbackQueryAnswerPromise",
);
type CallbackQueryAnswer = {
  promise: Promise<unknown>;
  pending: boolean;
  retainUntilDispatch: boolean;
};
// Consuming an answer must not stop coalescing in-flight requests. Only new rows
// retain settled answers: duplicate admissions may be tombstones that never dispatch.
const telegramCallbackQueryAnswers = new WeakMap<object, Map<string, CallbackQueryAnswer>>();

export function startTelegramCallbackQueryAnswer(
  bot: { api: { answerCallbackQuery: (id: string) => Promise<unknown> } },
  callbackQueryId: string,
  retainUntilDispatch: boolean,
): Promise<unknown> {
  let answers = telegramCallbackQueryAnswers.get(bot);
  if (!answers) {
    answers = new Map();
    telegramCallbackQueryAnswers.set(bot, answers);
  }
  const existing = answers.get(callbackQueryId);
  if (existing) {
    return existing.promise;
  }
  const answer = {
    promise: bot.api.answerCallbackQuery(callbackQueryId),
    pending: true,
    retainUntilDispatch,
  };
  answers.set(callbackQueryId, answer);
  void answer.promise.then(
    () => {
      answer.pending = false;
      if (!answer.retainUntilDispatch) {
        answers.delete(callbackQueryId);
      }
    },
    () => answers.delete(callbackQueryId),
  );
  return answer.promise;
}

export function takeTelegramCallbackQueryAdmissionAnswer(
  bot: object,
  callbackQueryId: string,
): Promise<unknown> | undefined {
  const answers = telegramCallbackQueryAnswers.get(bot);
  const answer = answers?.get(callbackQueryId);
  if (answer) {
    answer.retainUntilDispatch = false;
    if (!answer.pending) {
      answers?.delete(callbackQueryId);
    }
  }
  return answer?.promise;
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
