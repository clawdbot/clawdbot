import type { RuntimeLogger } from "../plugins/runtime/types-core.js";

export type RealtimeVoiceAgentTalkbackResult = {
  text: string;
};

export type RealtimeVoiceAgentTalkbackQueue = {
  close(): void;
  enqueue(question: string, metadata?: unknown): void;
};

export type RealtimeVoiceAgentTalkbackQueueParams = {
  debounceMs: number;
  isStopped: () => boolean;
  logger: Pick<RuntimeLogger, "info" | "warn">;
  logPrefix: string;
  responseStyle: string;
  fallbackText: string;
  consult: (args: {
    question: string;
    metadata?: unknown;
    responseStyle: string;
    signal: AbortSignal;
  }) => Promise<RealtimeVoiceAgentTalkbackResult>;
  deliver: (text: string) => void;
};

type PendingQuestion = {
  question: string;
  metadata?: unknown;
};

export function createRealtimeVoiceAgentTalkbackQueue(
  params: RealtimeVoiceAgentTalkbackQueueParams,
): RealtimeVoiceAgentTalkbackQueue {
  let active = false;
  let pendingQuestions: PendingQuestion[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let activeAbortController: AbortController | undefined;

  const clearDebounceTimer = () => {
    if (!debounceTimer) {
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  const run = async (pending: PendingQuestion): Promise<void> => {
    const trimmed = pending.question.trim();
    if (!trimmed || params.isStopped()) {
      return;
    }
    if (active) {
      appendPendingQuestion(pendingQuestions, {
        question: trimmed,
        metadata: pending.metadata,
      });
      return;
    }

    active = true;
    let nextQuestion: PendingQuestion | undefined = {
      question: trimmed,
      metadata: pending.metadata,
    };
    let consultStartedAt: number | undefined;
    try {
      while (nextQuestion) {
        if (params.isStopped()) {
          return;
        }
        const currentQuestion = nextQuestion;
        consultStartedAt = Date.now();
        params.logger.info(
          `${params.logPrefix} consult: chars=${currentQuestion.question.length} queued=${pendingQuestions.length}`,
        );
        activeAbortController = new AbortController();
        const result = await params.consult({
          question: currentQuestion.question,
          metadata: currentQuestion.metadata,
          responseStyle: params.responseStyle,
          signal: activeAbortController.signal,
        });
        activeAbortController = undefined;
        const text = result.text.trim();
        params.logger.info(
          `${params.logPrefix} consult done: elapsedMs=${Date.now() - consultStartedAt} answerChars=${text.length} queued=${pendingQuestions.length}`,
        );
        if (!params.isStopped() && text) {
          params.deliver(text);
        }
        nextQuestion = pendingQuestions.shift();
      }
    } catch (error) {
      activeAbortController = undefined;
      if (params.isStopped() || isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const elapsedDetail =
        consultStartedAt === undefined ? "" : ` elapsedMs=${Date.now() - consultStartedAt}`;
      params.logger.warn(`${params.logPrefix} consult failed:${elapsedDetail} ${message}`);
      params.deliver(params.fallbackText);
    } finally {
      active = false;
      const queuedQuestion = pendingQuestions.shift();
      if (queuedQuestion && !params.isStopped()) {
        void run(queuedQuestion);
      }
    }
  };

  return {
    close: () => {
      clearDebounceTimer();
      pendingQuestions = [];
      activeAbortController?.abort();
    },
    enqueue: (question, metadata) => {
      const trimmed = question.trim();
      if (!trimmed || params.isStopped()) {
        return;
      }
      if (active) {
        appendPendingQuestion(pendingQuestions, { question: trimmed, metadata });
        params.logger.info(
          `${params.logPrefix} consult queued: chars=${trimmed.length} queued=${pendingQuestions.length}`,
        );
        clearDebounceTimer();
        return;
      }
      appendPendingQuestion(pendingQuestions, { question: trimmed, metadata });
      clearDebounceTimer();
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        const queuedQuestion = pendingQuestions.shift();
        if (queuedQuestion && !params.isStopped()) {
          void run(queuedQuestion);
        }
      }, params.debounceMs);
      debounceTimer.unref?.();
    },
  };
}

function appendPendingQuestion(queue: PendingQuestion[], next: PendingQuestion): void {
  const current = queue.at(-1);
  if (current && Object.is(current.metadata, next.metadata)) {
    current.question = `${current.question}\n${next.question}`;
    return;
  }
  queue.push(next);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
