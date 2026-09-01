// Telegram public-poll answer context prepared before sequentialization.
import {
  findTelegramPollRegistryEntrySync,
  telegramPollRegistryKey,
  type TelegramPollRegistryEntry,
} from "./poll-registry.js";

type EligibleTelegramPollAnswerUpdate = object & {
  poll_answer: {
    poll_id: string;
    option_ids: number[];
    user: { is_bot?: boolean };
  };
};

export type PreparedTelegramPollAnswer = {
  entry: TelegramPollRegistryEntry | null;
  registrationPending?: true;
};

const preparedPollAnswers = new WeakMap<object, PreparedTelegramPollAnswer>();
const pendingPollRegistrations = new Map<
  string,
  {
    entry: TelegramPollRegistryEntry;
    completion: Promise<TelegramPollRegistryEntry | null>;
  }
>();

export function beginTelegramPollRegistration(params: {
  accountId?: string;
  entry: TelegramPollRegistryEntry;
}): {
  complete: (entry: TelegramPollRegistryEntry | null) => void;
} {
  const key = telegramPollRegistryKey(params.accountId, params.entry.pollId);
  let completeRegistration: (entry: TelegramPollRegistryEntry | null) => void = () => {};
  const completion = new Promise<TelegramPollRegistryEntry | null>((resolve) => {
    completeRegistration = resolve;
  });
  const registration = { entry: params.entry, completion };
  pendingPollRegistrations.set(key, registration);
  return {
    complete: (entry) => {
      completeRegistration(entry);
      if (pendingPollRegistrations.get(key) === registration) {
        pendingPollRegistrations.delete(key);
      }
    },
  };
}

export function prepareTelegramPollAnswerContext(params: {
  update: object;
  accountId?: string;
}): void {
  if (!isEligibleTelegramPollAnswerUpdate(params.update)) {
    return;
  }
  if (preparedPollAnswers.has(params.update)) {
    return;
  }
  const pollId = params.update.poll_answer.poll_id;
  const pending = pendingPollRegistrations.get(telegramPollRegistryKey(params.accountId, pollId));
  const prepared: PreparedTelegramPollAnswer = pending
    ? { entry: pending.entry, registrationPending: true }
    : {
        entry: findTelegramPollRegistryEntrySync({
          pollId,
          accountId: params.accountId,
        }),
      };
  preparedPollAnswers.set(params.update, prepared);
}

export async function settleTelegramPollAnswerContext(params: {
  update: object;
  accountId?: string;
}): Promise<void> {
  const prepared = preparedPollAnswers.get(params.update);
  if (!prepared?.registrationPending || !isEligibleTelegramPollAnswerUpdate(params.update)) {
    return;
  }
  const pollId = params.update.poll_answer.poll_id;
  const pending = pendingPollRegistrations.get(telegramPollRegistryKey(params.accountId, pollId));
  const entry = pending
    ? await pending.completion
    : findTelegramPollRegistryEntrySync({ pollId, accountId: params.accountId });
  preparedPollAnswers.set(params.update, { entry });
}

export function getPreparedTelegramPollAnswer(
  update: object,
): PreparedTelegramPollAnswer | undefined {
  return preparedPollAnswers.get(update);
}

export function isEligibleTelegramPollAnswerUpdate(
  update: unknown,
): update is EligibleTelegramPollAnswerUpdate {
  if (!update || typeof update !== "object") {
    return false;
  }
  const pollAnswer = (update as { poll_answer?: EligibleTelegramPollAnswerUpdate["poll_answer"] })
    .poll_answer;
  return Boolean(
    pollAnswer?.poll_id &&
    pollAnswer.user &&
    !pollAnswer.user.is_bot &&
    pollAnswer.option_ids?.length,
  );
}

export function recordPreparedTelegramPollAnswer(
  update: object,
  prepared: PreparedTelegramPollAnswer,
): void {
  preparedPollAnswers.set(update, prepared);
}
