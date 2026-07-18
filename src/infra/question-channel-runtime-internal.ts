import type {
  QuestionRecord,
  QuestionResolvedEvent,
} from "../../packages/gateway-protocol/src/schema/questions.js";

const TERMINAL_DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;

type QuestionDeliveryFinalizer = (statusLine: string) => void | Promise<void>;

type QuestionChannelEntry = {
  record?: QuestionRecord;
  terminal?: QuestionResolvedEvent;
  deliveries: Map<string, QuestionDeliveryFinalizer>;
  finalizedDeliveryIds: Set<string>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

type QuestionChannelRuntime = {
  handleRequested: (record: QuestionRecord) => void;
  handleResolved: (event: QuestionResolvedEvent) => void;
  registerDelivery: (params: {
    questionId: string;
    deliveryId: string;
    finalize: QuestionDeliveryFinalizer;
  }) => void;
  clear: () => void;
};

function collectAnsweredLabels(
  record: QuestionRecord | undefined,
  event: Extract<QuestionResolvedEvent, { status: "answered" }>,
): string[] {
  if (!record) {
    return [];
  }
  const answers = event.answers.answers;
  return record.questions.flatMap((question) => {
    // Only declared choices are safe to echo. Free-text answers can contain
    // secrets, mentions, or transport markup, and the label filter below drops
    // them; isOther alone must not suppress a declared selection.
    if (question.isSecret || question.options.length === 0) {
      return [];
    }
    const optionLabels = new Set(question.options.map((option) => option.label));
    return (answers[question.id]?.answers ?? []).filter((answer) => optionLabels.has(answer));
  });
}

function formatQuestionTerminalStatusLine(params: {
  record?: QuestionRecord;
  event: QuestionResolvedEvent;
}): string {
  if (params.event.status === "expired") {
    return "Expired";
  }
  if (params.event.status === "cancelled") {
    return "Cancelled";
  }
  const labels = collectAnsweredLabels(params.record, params.event);
  return labels.length > 0 ? `Answered: ${labels.join(", ")}` : "Answered";
}

export function createQuestionChannelRuntime(
  options: {
    onFinalizeError?: (error: unknown, questionId: string, deliveryId: string) => void;
    terminalRetentionMs?: number;
  } = {},
): QuestionChannelRuntime {
  const entries = new Map<string, QuestionChannelEntry>();
  const terminalRetentionMs = options.terminalRetentionMs ?? TERMINAL_DELIVERY_RETENTION_MS;

  const getOrCreate = (questionId: string): QuestionChannelEntry => {
    const existing = entries.get(questionId);
    if (existing) {
      return existing;
    }
    const created: QuestionChannelEntry = {
      deliveries: new Map(),
      finalizedDeliveryIds: new Set(),
    };
    entries.set(questionId, created);
    return created;
  };

  const finalizeDelivery = (
    questionId: string,
    entry: QuestionChannelEntry,
    deliveryId: string,
    finalize: QuestionDeliveryFinalizer,
  ) => {
    if (!entry.terminal || entry.finalizedDeliveryIds.has(deliveryId)) {
      return;
    }
    entry.deliveries.delete(deliveryId);
    entry.finalizedDeliveryIds.add(deliveryId);
    const statusLine = formatQuestionTerminalStatusLine({
      record: entry.record,
      event: entry.terminal,
    });
    try {
      void Promise.resolve(finalize(statusLine)).catch((error: unknown) =>
        options.onFinalizeError?.(error, questionId, deliveryId),
      );
    } catch (error) {
      options.onFinalizeError?.(error, questionId, deliveryId);
    }
  };

  const scheduleCleanup = (questionId: string, entry: QuestionChannelEntry) => {
    if (entry.cleanupTimer) {
      return;
    }
    entry.cleanupTimer = setTimeout(() => {
      if (entries.get(questionId) === entry) {
        entries.delete(questionId);
      }
    }, terminalRetentionMs);
    entry.cleanupTimer.unref?.();
  };

  return {
    handleRequested(record) {
      const entry = getOrCreate(record.id);
      entry.record = record;
    },
    handleResolved(event) {
      const entry = getOrCreate(event.id);
      if (entry.terminal) {
        return;
      }
      entry.terminal = event;
      for (const [deliveryId, finalize] of entry.deliveries) {
        finalizeDelivery(event.id, entry, deliveryId, finalize);
      }
      scheduleCleanup(event.id, entry);
    },
    registerDelivery({ questionId, deliveryId, finalize }) {
      const entry = getOrCreate(questionId);
      if (entry.finalizedDeliveryIds.has(deliveryId)) {
        return;
      }
      entry.deliveries.set(deliveryId, finalize);
      finalizeDelivery(questionId, entry, deliveryId, finalize);
    },
    clear() {
      for (const entry of entries.values()) {
        if (entry.cleanupTimer) {
          clearTimeout(entry.cleanupTimer);
        }
      }
      entries.clear();
    },
  };
}
