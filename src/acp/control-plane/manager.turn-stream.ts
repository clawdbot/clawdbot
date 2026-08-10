/** Normalizes ACP runtime turn event/result streams into manager-facing outcomes. */
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "@openclaw/acp-core/runtime/types";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpPromptSubmissionState } from "./manager.types.js";
import { normalizeAcpErrorCode } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";

/** Mutable gate used to suppress late events after timeout/cancel races. */
type AcpTurnEventGate = {
  open: boolean;
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
    } else if (event.type === "text_delta" || event.type === "tool_call") {
      sawOutput = true;
      await params.onOutputEvent?.(event);
    }
    await params.onEvent?.(forwardedEvent);
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

function invokeAcpPromptObserver(observer: (() => Promise<void> | void) | undefined): void {
  void Promise.resolve()
    .then(() => observer?.())
    .catch(() => {
      // Prompt observation must not affect a request that was already submitted.
    });
}

function observeAcpPromptSubmission(params: {
  promptSubmission: Promise<AcpPromptSubmissionState> | undefined;
  onPromptSubmissionState: (state: AcpPromptSubmissionState) => void;
  onPromptStarted?: () => Promise<void> | void;
}): () => void {
  let observationOpen = true;
  const observeSubmissionState = (state: AcpPromptSubmissionState) => {
    if (!observationOpen) {
      return;
    }
    params.onPromptSubmissionState(state);
  };
  const observePromptStarted = () => {
    if (!observationOpen) {
      return;
    }
    invokeAcpPromptObserver(params.onPromptStarted);
  };
  if (params.promptSubmission) {
    observeSubmissionState("unknown");
    void params.promptSubmission.then(
      (state) => {
        observeSubmissionState(state);
        if (state === "submitted") {
          observePromptStarted();
        }
      },
      () => {
        observeSubmissionState("unknown");
      },
    );
    return () => {
      observationOpen = false;
    };
  }
  observeSubmissionState("unknown");
  return () => {
    observationOpen = false;
  };
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
  onPromptSubmissionState: (state: AcpPromptSubmissionState) => void;
  onPromptStarted?: () => Promise<void> | void;
  onTurnStreamAcquired?: () => Promise<void> | void;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome> {
  if (params.runtime.startTurn) {
    // startTurn exposes result and event streams separately; coordinate both before reporting done.
    const turn = params.runtime.startTurn(params.turn);
    invokeAcpPromptObserver(params.onTurnStreamAcquired);
    const stopObservingPromptSubmission = observeAcpPromptSubmission({
      promptSubmission: turn.promptSubmission,
      onPromptSubmissionState: params.onPromptSubmissionState,
      onPromptStarted: params.onPromptStarted,
    });
    try {
      const eventsPromise = consumeAcpTurnEvents({
        events: turn.events,
        eventGate: params.eventGate,
        onEvent: params.onEvent,
        onOutputEvent: params.onOutputEvent,
      }).then(
        (outcome) => ({ kind: "events" as const, outcome }),
        (error: unknown) => ({ kind: "event-error" as const, error }),
      );
      const resultPromise = turn.result.then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "result-error" as const, error }),
      );

      let eventOutcome: AcpTurnStreamOutcome | null = null;
      let result: AcpRuntimeTurnResult | null = null;
      const firstOutcome = await Promise.race([eventsPromise, resultPromise]);
      if (firstOutcome.kind === "event-error") {
        await turn.closeStream({ reason: "turn-events-error" }).catch(() => {});
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
      if (!eventOutcome) {
        let eventsOutcome = await Promise.race([eventsPromise, waitForQueuedEvents()]);
        if (eventsOutcome === "pending") {
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
    } finally {
      stopObservingPromptSubmission();
    }
  }

  const events = params.runtime.runTurn(params.turn);
  params.onPromptSubmissionState("unknown");
  invokeAcpPromptObserver(params.onTurnStreamAcquired);
  return await consumeAcpTurnEvents({
    events,
    eventGate: params.eventGate,
    onEvent: params.onEvent,
    onOutputEvent: params.onOutputEvent,
  });
}
