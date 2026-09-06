/** Normalizes ACP runtime turn event/result streams into manager-facing outcomes. */
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "@openclaw/acp-core/runtime/types";
import { AcpRuntimeError } from "../runtime/errors.js";
import { normalizeAcpErrorCode } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";

/** Mutable gate used to suppress late events after timeout/cancel races. */
type AcpTurnEventGate = {
  open: boolean;
  pendingDelivery?: Promise<void>;
};

/** Summary of whether a turn stream emitted user-visible output or terminal events. */
type AcpTurnStreamOutcome = {
  sawOutput: boolean;
  terminalStatus?: "completed" | "cancelled";
};

function isCancellationStopReason(stopReason: string | undefined): boolean {
  return stopReason === "cancel" || stopReason === "cancelled" || stopReason === "manual-cancel";
}

/** Resolves legacy and current done events to the manager's canonical terminal status. */
function resolveAcpTurnTerminalStatus(
  event: Extract<AcpRuntimeEvent, { type: "done" }>,
): "completed" | "cancelled" {
  return event.status ?? (isCancellationStopReason(event.stopReason) ? "cancelled" : "completed");
}

async function consumeAcpTurnEvents(params: {
  events: AsyncIterable<AcpRuntimeEvent>;
  eventGate: AcpTurnEventGate;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome> {
  let streamError: AcpRuntimeError | null = null;
  let sawOutput = false;
  let terminalStatus: AcpTurnStreamOutcome["terminalStatus"];

  for await (const event of params.events) {
    if (!params.eventGate.open) {
      continue;
    }
    let forwardedEvent = event;
    if (event.type === "done") {
      // Legacy runTurn adapters may omit status but retain the cancellation reason.
      terminalStatus = resolveAcpTurnTerminalStatus(event);
      forwardedEvent = { ...event, status: terminalStatus };
    } else if (event.type === "error") {
      streamError = new AcpRuntimeError(
        normalizeAcpErrorCode(event.code),
        normalizeText(event.message) || "ACP turn failed before completion.",
        event.detailCode ? { detailCode: event.detailCode } : undefined,
      );
    }
    const outputEvent =
      event.type === "text_delta" || event.type === "tool_call" ? event : undefined;
    if (outputEvent) {
      sawOutput = true;
    }
    params.eventGate.pendingDelivery = Promise.resolve(
      outputEvent ? params.onOutputEvent?.(outputEvent) : undefined,
    ).then(() => params.onEvent?.(forwardedEvent));
    try {
      await params.eventGate.pendingDelivery;
    } finally {
      params.eventGate.pendingDelivery = undefined;
    }
  }

  if (params.eventGate.open && streamError) {
    throw streamError;
  }

  return {
    sawOutput,
    terminalStatus,
  };
}

function errorFromTurnResult(result: Extract<AcpRuntimeTurnResult, { status: "failed" }>) {
  return new AcpRuntimeError(
    normalizeAcpErrorCode(result.error.code),
    normalizeText(result.error.message) || "ACP turn failed before completion.",
    result.error.detailCode ? { detailCode: result.error.detailCode } : undefined,
  );
}

function waitForQueuedEvents(): Promise<"pending"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("pending"), 0);
  });
}

async function notifyTerminalResult(params: {
  result: AcpRuntimeTurnResult;
  eventGate: AcpTurnEventGate;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
}): Promise<void> {
  if (!params.eventGate.open) {
    return;
  }
  if (params.result.status === "completed" || params.result.status === "cancelled") {
    await params.onEvent?.({
      type: "done",
      status: params.result.status,
      ...(params.result.stopReason ? { stopReason: params.result.stopReason } : {}),
    });
    return;
  }
  await params.onEvent?.({
    type: "error",
    code: normalizeAcpErrorCode(params.result.error.code),
    ...(params.result.error.detailCode ? { detailCode: params.result.error.detailCode } : {}),
    message: normalizeText(params.result.error.message) || "ACP turn failed before completion.",
    ...(params.result.error.retryable === undefined
      ? {}
      : { retryable: params.result.error.retryable }),
  });
}

/** Consumes runtime turn APIs and emits normalized events while tracking output/terminal state. */
export async function consumeAcpTurnStream(params: {
  runtime: AcpRuntime;
  turn: AcpRuntimeTurnInput;
  eventGate: AcpTurnEventGate;
  onBeforePrompt?: () => Promise<void> | void;
  onPromptStarted?: (params: { authoritative: boolean }) => Promise<void> | void;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome> {
  // Gateway admission can still close while runtime preparation is awaited.
  if (params.onBeforePrompt) {
    await params.onBeforePrompt();
  }
  if (params.runtime.startTurn) {
    // Submission readiness and terminal cleanup are independent backend-owned turn boundaries.
    const turn = params.runtime.startTurn(params.turn);
    let promptReadinessOpen = true;
    const readinessPromise = turn.promptStarted?.then(
      async () => {
        if (!promptReadinessOpen) {
          return { kind: "prompt-start-closed" as const };
        }
        await params.onPromptStarted?.({ authoritative: true });
        return { kind: "prompt-started" as const };
      },
      (error: unknown) => ({ kind: "prompt-start-error" as const, error }),
    );
    const resultPromise = turn.result.then(
      (result) => {
        promptReadinessOpen = false;
        return { kind: "result" as const, result };
      },
      (error: unknown) => {
        promptReadinessOpen = false;
        return { kind: "result-error" as const, error };
      },
    );
    const eventsPromise = consumeAcpTurnEvents({
      events: turn.events,
      eventGate: params.eventGate,
      onEvent: params.onEvent,
      onOutputEvent: params.onOutputEvent,
    }).then(
      (outcome) => ({ kind: "events" as const, outcome }),
      async (error: unknown) => {
        // Event delivery can fail before prompt readiness. Cancel its producer
        // immediately, then retain the actor until backend cleanup completes.
        await turn.cancel({ reason: "turn-events-error" }).catch(() => {});
        await turn.closeStream({ reason: "turn-events-error" }).catch(() => {});
        await resultPromise;
        return { kind: "event-error" as const, error };
      },
    );

    if (readinessPromise) {
      const readiness = await Promise.race([readinessPromise, resultPromise]);
      if (readiness.kind === "prompt-start-error") {
        await turn.closeStream({ reason: "turn-prompt-start-error" }).catch(() => {});
        // The canonical result settles only after backend persistence and client cleanup finish.
        const terminalOutcome = await resultPromise;
        if (terminalOutcome.kind === "result" && terminalOutcome.result.status === "completed") {
          throw readiness.error;
        }
      }
    } else {
      // Third-party adapters predating readiness retain their existing output-based replay rules.
      await params.onPromptStarted?.({ authoritative: false });
    }

    let eventOutcome: AcpTurnStreamOutcome | null = null;
    let result: AcpRuntimeTurnResult | null = null;
    const firstOutcome = await Promise.race([eventsPromise, resultPromise]);
    if (firstOutcome.kind === "event-error") {
      throw firstOutcome.error;
    }
    if (firstOutcome.kind === "events") {
      eventOutcome = firstOutcome.outcome;
    } else if (firstOutcome.kind === "result-error") {
      await turn.closeStream({ reason: "turn-result-error" }).catch(() => {});
      throw firstOutcome.error;
    } else {
      result = firstOutcome.result;
    }

    if (!result) {
      const terminalOutcome = await resultPromise;
      if (terminalOutcome.kind === "result-error") {
        await turn.closeStream({ reason: "turn-result-error" }).catch(() => {});
        throw terminalOutcome.error;
      }
      result = terminalOutcome.result;
    }

    let closedTerminalStream = false;
    while (!eventOutcome) {
      // Channel delivery can outlive the backend result. Only an idle event
      // iterator may be closed; closeStream discards queued ACPX output.
      await params.eventGate.pendingDelivery?.catch(() => {});
      let eventsOutcome = await Promise.race([eventsPromise, waitForQueuedEvents()]);
      if (eventsOutcome === "pending") {
        if (params.eventGate.pendingDelivery) {
          continue;
        }
        await turn.closeStream({ reason: `turn-result-${result.status}` }).catch(() => {});
        closedTerminalStream = true;
        eventsOutcome = await eventsPromise;
      }
      if (eventsOutcome.kind === "event-error") {
        throw eventsOutcome.error;
      }
      eventOutcome = eventsOutcome.outcome;
    }
    if (result.status !== "completed" && !closedTerminalStream) {
      await turn.closeStream({ reason: `turn-result-${result.status}` }).catch(() => {});
    }
    await notifyTerminalResult({
      result,
      eventGate: params.eventGate,
      onEvent: params.onEvent,
    });
    if (result.status === "failed") {
      throw errorFromTurnResult(result);
    }
    return {
      sawOutput: eventOutcome.sawOutput,
      terminalStatus: result.status,
    };
  }

  const events = params.runtime.runTurn(params.turn);
  await params.onPromptStarted?.({ authoritative: false });
  return await consumeAcpTurnEvents({
    events,
    eventGate: params.eventGate,
    onEvent: params.onEvent,
    onOutputEvent: params.onOutputEvent,
  });
}
