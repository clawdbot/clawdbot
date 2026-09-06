import { AsyncLocalStorage } from "node:async_hooks";
import type {
  QuestionRecord,
  QuestionResolvedEvent,
} from "../../packages/gateway-protocol/src/schema/questions.js";
import { runWithRetainedGatewayRootWork } from "../process/gateway-work-admission.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../shared/async-work-scope.js";

const TERMINAL_DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;

type QuestionDeliveryFinalizer = (statusLine: string) => void | Promise<void>;

type QuestionChannelEntry = {
  record: QuestionRecord;
  owner: AbortSignal | undefined;
  track: ReturnType<typeof captureAsyncWorkTracker>;
  terminal?: QuestionResolvedEvent;
  deliveries: Map<string, QuestionDeliveryFinalizer>;
  finalizedDeliveryIds: Set<string>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

type QuestionChannelRuntime = {
  handleRequested: (record: QuestionRecord) => void;
  handleResolved: (event: QuestionResolvedEvent) => void;
  runWithDeliveries: <T>(
    questionIds: readonly (string | undefined)[],
    run: () => T,
    options?: { unbound?: boolean },
  ) => T;
  registerDelivery: (params: {
    questionId: string;
    deliveryId: string;
    finalize: QuestionDeliveryFinalizer;
  }) => void;
  retireGateway: (owner: AbortSignal) => void;
  clear: () => Promise<void>;
};

function collectAnsweredLabels(
  record: QuestionRecord,
  event: Extract<QuestionResolvedEvent, { status: "answered" }>,
): string[] {
  const answers = event.answers.answers;
  return record.questions.flatMap((question) => {
    // Only declared choices are safe to echo. Free-text answers can contain
    // secrets, mentions, or transport markup, and the label filter below drops
    // them; isOther alone must not suppress a declared selection.
    if (question.isSecret || question.options.length === 0) {
      return [];
    }
    const optionLabels = new Set(question.options.map((option) => option.label));
    return (answers[question.questionId] ?? []).filter((answer) => optionLabels.has(answer));
  });
}

function formatQuestionTerminalStatusLine(params: {
  record: QuestionRecord;
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
  const retainedEntries = new Set<QuestionChannelEntry>();
  const deliveryContext = new AsyncLocalStorage<{
    entries: Map<string, QuestionChannelEntry | undefined>;
    finalizers: AsyncWorkScope;
    owner: AbortSignal | undefined;
    track: ReturnType<typeof captureAsyncWorkTracker>;
  }>();
  const retiredGateways = new WeakSet<AbortSignal>();
  let finalizers = new AsyncWorkScope();
  let clearing: Promise<void> | undefined;
  const terminalRetentionMs = options.terminalRetentionMs ?? TERMINAL_DELIVERY_RETENTION_MS;

  const runFinalizer = (
    questionId: string,
    deliveryId: string,
    finalize: QuestionDeliveryFinalizer,
    statusLine: string,
    track: ReturnType<typeof captureAsyncWorkTracker>,
  ) => {
    // Reset joins the original callback; its captured owner retains descendants.
    void finalizers
      .track(() => track(() => runWithRetainedGatewayRootWork(() => finalize(statusLine))))
      .catch((error: unknown) => options.onFinalizeError?.(error, questionId, deliveryId));
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
    runFinalizer(questionId, deliveryId, finalize, statusLine, entry.track);
  };

  const releaseEntry = (entry: QuestionChannelEntry) => {
    retainedEntries.delete(entry);
    if (entries.get(entry.record.id) === entry) {
      entries.delete(entry.record.id);
    }
    clearTimeout(entry.cleanupTimer);
    entry.deliveries.clear();
    entry.finalizedDeliveryIds.clear();
  };

  const scheduleCleanup = (entry: QuestionChannelEntry) => {
    if (entry.cleanupTimer || !retainedEntries.has(entry)) {
      return;
    }
    entry.cleanupTimer = setTimeout(() => releaseEntry(entry), terminalRetentionMs);
    entry.cleanupTimer.unref?.();
  };

  return {
    handleRequested(record) {
      const owner = getAsyncWorkSignal();
      if (clearing || (owner && retiredGateways.has(owner))) {
        return;
      }
      // The host publishes Requested before delivery; callbacks cannot create
      // entries. A fresh accepted request may reuse an id after the manager's grace.
      const entry: QuestionChannelEntry = {
        record,
        owner,
        track: captureAsyncWorkTracker(),
        deliveries: new Map(),
        finalizedDeliveryIds: new Set(),
      };
      retainedEntries.add(entry);
      entries.set(record.id, entry);
    },
    handleResolved(event) {
      const entry = entries.get(event.id);
      if (!entry || entry.terminal) {
        return;
      }
      entry.terminal = event;
      for (const [deliveryId, finalize] of entry.deliveries) {
        finalizeDelivery(event.id, entry, deliveryId, finalize);
      }
      scheduleCleanup(entry);
    },
    runWithDeliveries(questionIds, run, deliveryOptions) {
      if (!questionIds.some(Boolean)) {
        return run();
      }
      const parent = deliveryContext.getStore();
      const captured = new Map(parent?.entries);
      for (const id of questionIds) {
        if (id && (deliveryOptions?.unbound || !captured.has(id))) {
          captured.set(id, deliveryOptions?.unbound ? undefined : entries.get(id));
        }
      }
      // Retain the pre-send generation across queues. Restored custody cannot
      // borrow a retry caller's binding for a different, regenerated payload.
      return deliveryContext.run(
        {
          entries: captured,
          finalizers: parent?.finalizers ?? finalizers,
          owner: parent ? parent.owner : getAsyncWorkSignal(),
          track: parent ? parent.track : captureAsyncWorkTracker(),
        },
        run,
      );
    },
    registerDelivery({ questionId, deliveryId, finalize }) {
      const captured = deliveryContext.getStore();
      if (
        clearing ||
        (captured &&
          (captured.finalizers !== finalizers ||
            (captured.owner && retiredGateways.has(captured.owner))))
      ) {
        return;
      }
      const entry = captured?.entries.has(questionId)
        ? captured.entries.get(questionId)
        : entries.get(questionId);
      if (entry?.owner && retiredGateways.has(entry.owner)) {
        return;
      }
      if (!entry || !retainedEntries.has(entry)) {
        // Lost or expired bindings cannot use a replacement request. Disable
        // every native target on the still-live delivery owner.
        if (captured?.entries.has(questionId)) {
          runFinalizer(
            questionId,
            deliveryId,
            finalize,
            "Unavailable: request a new question.",
            captured.track,
          );
        }
        return;
      }
      if (entry.finalizedDeliveryIds.has(deliveryId)) {
        return;
      }
      entry.deliveries.set(deliveryId, finalize);
      finalizeDelivery(questionId, entry, deliveryId, finalize);
    },
    retireGateway(owner) {
      // The Gateway calls this after joining received work and its finalizers,
      // not at beginClose: an admitted resolve can still finalize deliveries.
      retiredGateways.add(owner);
      for (const entry of retainedEntries) {
        if (entry.owner === owner) {
          releaseEntry(entry);
        }
      }
    },
    clear() {
      if (clearing) {
        return clearing;
      }
      for (const entry of retainedEntries) {
        releaseEntry(entry);
      }
      clearing = finalizers.drain().then(() => {
        finalizers = new AsyncWorkScope();
        clearing = undefined;
      });
      return clearing;
    },
  };
}
