import {
  matchRealtimeVoiceConsultQuestions,
  readRealtimeVoiceConsultQuestion,
} from "./consult-question.js";

const DEFAULT_REALTIME_VOICE_FORCED_CONSULT_NATIVE_DEDUPE_MS = 2_000;
const DEFAULT_REALTIME_VOICE_FORCED_CONSULT_LIMIT = 12;

export type RealtimeVoiceForcedConsultTimer = {
  clear(): void;
};

export type RealtimeVoiceForcedConsultCoordinatorOptions = {
  limit?: number;
  nativeDedupeMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => RealtimeVoiceForcedConsultTimer;
  questionsMatch?: (left: string | undefined, right: string | undefined) => boolean;
};

export type RealtimeVoiceForcedConsultHandle<TContext = unknown> = {
  id: string;
  question: string;
  context?: TContext;
};

export type RealtimeVoiceForcedConsultNativeMatch<TContext = unknown> =
  | { kind: "none"; question?: string }
  | { kind: "pending"; question?: string; handle: RealtimeVoiceForcedConsultHandle<TContext> }
  | { kind: "in_flight"; question?: string; handle: RealtimeVoiceForcedConsultHandle<TContext> }
  | {
      kind: "already_delivered";
      question?: string;
      handle: RealtimeVoiceForcedConsultHandle<TContext>;
    };

export type RealtimeVoiceForcedConsultNativeRecentOptions = {
  allowUnknownQuestion?: boolean;
};

export type RealtimeVoiceForcedConsultCoordinator<TContext = unknown> = {
  prepare(
    question: string,
    options?: { context?: TContext; id?: string },
  ): RealtimeVoiceForcedConsultHandle<TContext> | undefined;
  schedule(
    handle: RealtimeVoiceForcedConsultHandle<TContext>,
    delayMs: number,
    run: (handle: RealtimeVoiceForcedConsultHandle<TContext>) => void,
  ): void;
  clearPending(): void;
  consumePending(question?: string): RealtimeVoiceForcedConsultHandle<TContext> | undefined;
  cancelPending(handle: RealtimeVoiceForcedConsultHandle<TContext>): void;
  recordNativeConsult(
    args: unknown,
    nativeCallId?: string,
  ): RealtimeVoiceForcedConsultNativeMatch<TContext>;
  markStarted(handle: RealtimeVoiceForcedConsultHandle<TContext>): void;
  markDelivered(handle: RealtimeVoiceForcedConsultHandle<TContext>): void;
  markCancelled(handle: RealtimeVoiceForcedConsultHandle<TContext>): void;
  isCancelled(handle: RealtimeVoiceForcedConsultHandle<TContext>): boolean;
  nativeCallIds(handle: RealtimeVoiceForcedConsultHandle<TContext>): readonly string[];
  handles(): readonly RealtimeVoiceForcedConsultHandle<TContext>[];
  rememberQuestion(handle: RealtimeVoiceForcedConsultHandle<TContext>, question: string): void;
  findRecent(question: string): RealtimeVoiceForcedConsultHandle<TContext> | undefined;
  hasRecent(question: string): boolean;
  hasRecentNativeConsult(
    question: string,
    options?: RealtimeVoiceForcedConsultNativeRecentOptions,
  ): boolean;
  remove(handle: RealtimeVoiceForcedConsultHandle<TContext>): void;
  clear(): void;
};

type StoredForcedConsult<TContext> = {
  handle: RealtimeVoiceForcedConsultHandle<TContext>;
  createdAt: number;
  nativeCallIds: Set<string>;
  questions: string[];
  pending: boolean;
  started: boolean;
  delivered: boolean;
  cancelled: boolean;
  timer?: RealtimeVoiceForcedConsultTimer;
  cleanupTimer?: RealtimeVoiceForcedConsultTimer;
};

type RecentNativeConsult = {
  question?: string;
  at: number;
};

export function createRealtimeVoiceForcedConsultCoordinator<TContext = unknown>(
  options: RealtimeVoiceForcedConsultCoordinatorOptions = {},
): RealtimeVoiceForcedConsultCoordinator<TContext> {
  const state = new Map<string, StoredForcedConsult<TContext>>();
  const recentNativeConsults: RecentNativeConsult[] = [];
  let nextId = 0;
  const now = options.now ?? Date.now;
  const limit = options.limit ?? DEFAULT_REALTIME_VOICE_FORCED_CONSULT_LIMIT;
  const nativeDedupeMs =
    options.nativeDedupeMs ?? DEFAULT_REALTIME_VOICE_FORCED_CONSULT_NATIVE_DEDUPE_MS;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return { clear: () => clearTimeout(timer) };
    });
  const questionsMatch = options.questionsMatch ?? matchRealtimeVoiceConsultQuestions;

  const clearTimer = (stored: StoredForcedConsult<TContext>) => {
    stored.timer?.clear();
    stored.timer = undefined;
  };

  const scheduleCleanup = (stored: StoredForcedConsult<TContext>) => {
    stored.cleanupTimer?.clear();
    stored.cleanupTimer = setTimer(() => {
      if (state.get(stored.handle.id) === stored) {
        state.delete(stored.handle.id);
      }
    }, nativeDedupeMs);
  };

  const prune = () => {
    const earliestRecentNative = now() - nativeDedupeMs;
    for (let index = recentNativeConsults.length - 1; index >= 0; index -= 1) {
      const recent = recentNativeConsults[index];
      if (recent && recent.at < earliestRecentNative) {
        recentNativeConsults.splice(index, 1);
      }
    }
    while (recentNativeConsults.length > limit) {
      recentNativeConsults.shift();
    }
    while (state.size > limit) {
      const first = state.values().next().value;
      if (!first) {
        return;
      }
      first.timer?.clear();
      first.cleanupTimer?.clear();
      state.delete(first.handle.id);
    }
  };

  const findMatching = (question: string | undefined) => {
    if (!question) {
      return undefined;
    }
    const stored = [...state.values()]
      .toReversed()
      .find((candidate) =>
        candidate.questions.some((candidateQuestion) =>
          questionsMatch(candidateQuestion, question),
        ),
      );
    return stored;
  };

  const rememberStoredQuestion = (
    stored: StoredForcedConsult<TContext>,
    question: string | undefined,
  ) => {
    const trimmed = question?.trim();
    if (!trimmed) {
      return;
    }
    if (stored.questions.some((candidate) => questionsMatch(candidate, trimmed))) {
      return;
    }
    stored.questions.push(trimmed);
  };

  const recordRecentNativeConsult = (question: string | undefined) => {
    recentNativeConsults.push({ question, at: now() });
    prune();
  };

  const hasRecentNativeConsult = (
    question: string,
    recentOptions: RealtimeVoiceForcedConsultNativeRecentOptions = {},
  ) => {
    prune();
    return recentNativeConsults
      .toReversed()
      .some((recent) =>
        recent.question
          ? questionsMatch(recent.question, question)
          : recentOptions.allowUnknownQuestion === true,
      );
  };

  const getStored = (handle: RealtimeVoiceForcedConsultHandle<TContext>) => state.get(handle.id);

  return {
    prepare(question, prepareOptions) {
      const trimmed = question.trim();
      if (!trimmed) {
        return undefined;
      }
      const id = prepareOptions?.id ?? `forced-consult:${now()}:${++nextId}`;
      const existing = state.get(id);
      if (existing) {
        existing.timer?.clear();
        existing.cleanupTimer?.clear();
      }
      const handle: RealtimeVoiceForcedConsultHandle<TContext> = {
        id,
        question: trimmed,
        ...(prepareOptions && "context" in prepareOptions
          ? { context: prepareOptions.context }
          : {}),
      };
      state.set(handle.id, {
        handle,
        createdAt: now(),
        nativeCallIds: new Set(),
        questions: [trimmed],
        pending: true,
        started: false,
        delivered: false,
        cancelled: false,
      });
      prune();
      return handle;
    },
    schedule(handle, delayMs, run) {
      const stored = getStored(handle);
      if (!stored || !stored.pending || stored.timer) {
        return;
      }
      stored.timer = setTimer(() => {
        stored.timer = undefined;
        if (state.get(handle.id) === stored && stored.pending && !stored.cancelled) {
          run(handle);
        }
      }, delayMs);
    },
    clearPending() {
      for (const stored of state.values()) {
        if (stored.pending) {
          clearTimer(stored);
          state.delete(stored.handle.id);
        }
      }
    },
    consumePending(question) {
      const pendingCandidates = [...state.values()].filter((candidate) => candidate.pending);
      const stored =
        !question && pendingCandidates.length === 1
          ? pendingCandidates[0]
          : pendingCandidates
              .toReversed()
              .find((candidate) =>
                candidate.questions.some((candidateQuestion) =>
                  questionsMatch(candidateQuestion, question),
                ),
              );
      if (!stored?.pending) {
        return undefined;
      }
      clearTimer(stored);
      stored.pending = false;
      return stored.handle;
    },
    cancelPending(handle) {
      const stored = getStored(handle);
      if (!stored?.pending) {
        return;
      }
      clearTimer(stored);
      stored.pending = false;
      state.delete(handle.id);
    },
    recordNativeConsult(args, nativeCallId) {
      const question = readRealtimeVoiceConsultQuestion(args);
      recordRecentNativeConsult(question);
      const pending = [...state.values()]
        .toReversed()
        .find(
          (candidate) =>
            candidate.pending &&
            candidate.questions.some((candidateQuestion) =>
              questionsMatch(candidateQuestion, question),
            ),
        );
      if (pending) {
        clearTimer(pending);
        rememberStoredQuestion(pending, question);
        if (nativeCallId) {
          pending.nativeCallIds.add(nativeCallId);
        }
        pending.pending = false;
        scheduleCleanup(pending);
        return { kind: "pending", question, handle: pending.handle };
      }
      const stored = findMatching(question);
      if (!stored || stored.cancelled) {
        return { kind: "none", question };
      }
      if (nativeCallId) {
        stored.nativeCallIds.add(nativeCallId);
      }
      rememberStoredQuestion(stored, question);
      if (stored.delivered) {
        return { kind: "already_delivered", question, handle: stored.handle };
      }
      if (stored.started) {
        return { kind: "in_flight", question, handle: stored.handle };
      }
      return { kind: "none", question };
    },
    markStarted(handle) {
      const stored = getStored(handle);
      if (!stored) {
        return;
      }
      clearTimer(stored);
      stored.pending = false;
      stored.started = true;
    },
    markDelivered(handle) {
      const stored = getStored(handle);
      if (!stored) {
        return;
      }
      clearTimer(stored);
      stored.pending = false;
      stored.started = true;
      stored.delivered = true;
      scheduleCleanup(stored);
    },
    markCancelled(handle) {
      const stored = getStored(handle);
      if (!stored) {
        return;
      }
      clearTimer(stored);
      stored.pending = false;
      stored.cancelled = true;
      scheduleCleanup(stored);
    },
    isCancelled(handle) {
      return getStored(handle)?.cancelled === true;
    },
    nativeCallIds(handle) {
      return [...(getStored(handle)?.nativeCallIds ?? [])];
    },
    handles() {
      return [...state.values()].map((stored) => stored.handle);
    },
    rememberQuestion(handle, question) {
      const stored = getStored(handle);
      if (stored) {
        rememberStoredQuestion(stored, question);
      }
    },
    findRecent(question) {
      prune();
      return findMatching(question)?.handle;
    },
    hasRecent(question) {
      return Boolean(findMatching(question));
    },
    hasRecentNativeConsult,
    remove(handle) {
      const stored = getStored(handle);
      stored?.timer?.clear();
      stored?.cleanupTimer?.clear();
      state.delete(handle.id);
    },
    clear() {
      for (const stored of state.values()) {
        stored.timer?.clear();
        stored.cleanupTimer?.clear();
      }
      state.clear();
      recentNativeConsults.length = 0;
    },
  };
}
