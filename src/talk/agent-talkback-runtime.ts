/**
 * Debounced realtime voice talkback queue for delegated OpenClaw consults.
 *
 * Transcript fragments can arrive quickly while one consult is already running;
 * this queue batches compatible fragments, runs consults serially, and aborts
 * cleanly when the voice session closes.
 */
import type { RuntimeLogger } from "../plugins/runtime/types-core.js";

/** Text produced by a delegated voice consult. */
export type RealtimeVoiceAgentTalkbackResult = {
  text: string;
};

/** Minimal queue API owned by a realtime voice session. */
export type RealtimeVoiceAgentTalkbackQueue = {
  close(): void;
  enqueue(question: string, metadata?: unknown): void;
};

/** Runtime dependencies and policy knobs for the talkback queue. */
export type RealtimeVoiceAgentTalkbackQueueParams = {
  /** Delay used to merge nearby transcript fragments into one consult. */
  debounceMs: number;
  isStopped: () => boolean;
  logger: Pick<RuntimeLogger, "info" | "warn">;
  logPrefix: string;
  responseStyle: string;
  fallbackText: string;
  /** Delegates a batched question to OpenClaw and respects the abort signal. */
  consult: (args: {
    question: string;
    metadata?: unknown;
    responseStyle: string;
    signal: AbortSignal;
  }) => Promise<RealtimeVoiceAgentTalkbackResult>;
  /** Delivers final speakable text back to the realtime provider/session. */
  deliver: (text: string) => void;
};

type PendingQuestion = {
  question: string;
  metadata?: unknown;
};

/** Create a serial consult queue for realtime transcript talkback. */
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
      // Preserve order while avoiding concurrent consults; compatible metadata
      // fragments are merged by appendPendingQuestion below.
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
        // Continue draining any questions queued while the active consult ran.
        void run(queuedQuestion);
      }
    }
  };

  return {
    close: () => {
      clearDebounceTimer();
      pendingQuestions = [];
      // Abort only the active consult; pending work has already been dropped.
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
      // Debounce short transcript bursts so partial ASR fragments become a
      // single consult question instead of multiple back-to-back agent turns.
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
    // Metadata identity represents the caller/context lane; merge only when the
    // same lane produced adjacent fragments.
    current.question = `${current.question}\n${next.question}`;
    return;
  }
  queue.push(next);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
