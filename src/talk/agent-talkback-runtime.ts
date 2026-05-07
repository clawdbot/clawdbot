import type { RuntimeLogger } from "../plugins/runtime/types-core.js";

export type RealtimeVoiceAgentTalkbackResult = {
  text: string;
};

export type RealtimeVoiceAgentTalkbackQueue = {
  close(): void;
  enqueue(question: string): void;
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
    responseStyle: string;
    signal: AbortSignal;
  }) => Promise<RealtimeVoiceAgentTalkbackResult>;
  deliver: (text: string) => void;
};

export function createRealtimeVoiceAgentTalkbackQueue(
  params: RealtimeVoiceAgentTalkbackQueueParams,
): RealtimeVoiceAgentTalkbackQueue {
  let active = false;
  let pendingQuestion: string | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let activeAbortController: AbortController | undefined;

  const clearDebounceTimer = () => {
    if (!debounceTimer) {
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  };

  const run = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || params.isStopped()) {
      return;
    }
    if (active) {
      pendingQuestion = appendPendingQuestion(pendingQuestion, trimmed);
      return;
    }

    active = true;
    let nextQuestion: string | undefined = trimmed;
    try {
      while (nextQuestion) {
        if (params.isStopped()) {
          return;
        }
        const currentQuestion = nextQuestion;
        pendingQuestion = undefined;
        params.logger.info(`${params.logPrefix} consult: chars=${currentQuestion.length}`);
        activeAbortController = new AbortController();
        const result = await params.consult({
          question: currentQuestion,
          responseStyle: params.responseStyle,
          signal: activeAbortController.signal,
        });
        activeAbortController = undefined;
        const text = result.text.trim();
        if (!params.isStopped() && text) {
          params.deliver(text);
        }
        nextQuestion = pendingQuestion;
      }
    } catch (error) {
      activeAbortController = undefined;
      if (params.isStopped() || isAbortError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      params.logger.warn(`${params.logPrefix} consult failed: ${message}`);
      params.deliver(params.fallbackText);
    } finally {
      active = false;
      const queuedQuestion = pendingQuestion;
      pendingQuestion = undefined;
      if (queuedQuestion && !params.isStopped()) {
        void run(queuedQuestion);
      }
    }
  };

  return {
    close: () => {
      clearDebounceTimer();
      pendingQuestion = undefined;
      activeAbortController?.abort();
    },
    enqueue: (question) => {
      const trimmed = question.trim();
      if (!trimmed || params.isStopped()) {
        return;
      }
      if (active) {
        pendingQuestion = appendPendingQuestion(pendingQuestion, trimmed);
        clearDebounceTimer();
        return;
      }
      pendingQuestion = appendPendingQuestion(pendingQuestion, trimmed);
      clearDebounceTimer();
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        const queuedQuestion = pendingQuestion;
        pendingQuestion = undefined;
        if (queuedQuestion && !params.isStopped()) {
          void run(queuedQuestion);
        }
      }, params.debounceMs);
      debounceTimer.unref?.();
    },
  };
}

function appendPendingQuestion(current: string | undefined, next: string): string {
  return current ? `${current}\n${next}` : next;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
