import { AcpRuntimeError } from "../runtime/errors.js";
import type {
  AcpRuntime,
  AcpRuntimeEvent,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "../runtime/types.js";
import { normalizeAcpErrorCode } from "./manager.utils.js";
import { normalizeText } from "./runtime-options.js";

export type AcpTurnEventGate = {
  open: boolean;
};

export type AcpTurnStreamOutcome = {
  sawOutput: boolean;
  sawTerminalEvent: boolean;
};

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
  let sawTerminalEvent = false;

  for await (const event of params.events) {
    if (!params.eventGate.open) {
      continue;
    }
    if (event.type === "done") {
      sawTerminalEvent = true;
    } else if (event.type === "error") {
      streamError = new AcpRuntimeError(
        normalizeAcpErrorCode(event.code),
        normalizeText(event.message) || "ACP turn failed before completion.",
      );
    } else if (event.type === "text_delta" || event.type === "tool_call") {
      sawOutput = true;
      await params.onOutputEvent?.(event);
    }
    await params.onEvent?.(event);
  }

  if (params.eventGate.open && streamError) {
    throw streamError;
  }

  return {
    sawOutput,
    sawTerminalEvent,
  };
}

function errorFromTurnResult(result: Extract<AcpRuntimeTurnResult, { status: "failed" }>) {
  return new AcpRuntimeError(
    normalizeAcpErrorCode(result.error.code),
    normalizeText(result.error.message) || "ACP turn failed before completion.",
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
  if (params.result.status === "completed") {
    await params.onEvent?.({
      type: "done",
      ...(params.result.stopReason ? { stopReason: params.result.stopReason } : {}),
    });
    return;
  }
  if (params.result.status === "cancelled") {
    await params.onEvent?.({
      type: "done",
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

export async function consumeAcpTurnStream(params: {
  runtime: AcpRuntime;
  turn: AcpRuntimeTurnInput;
  eventGate: AcpTurnEventGate;
  onEvent?: (event: AcpRuntimeEvent) => Promise<void> | void;
  onOutputEvent?: (
    event: Extract<AcpRuntimeEvent, { type: "text_delta" | "tool_call" }>,
  ) => Promise<void> | void;
}): Promise<AcpTurnStreamOutcome> {
  if (params.runtime.startTurn) {
    const turn = params.runtime.startTurn(params.turn);
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
      sawTerminalEvent: true,
    };
  }

  return await consumeAcpTurnEvents({
    events: params.runtime.runTurn(params.turn),
    eventGate: params.eventGate,
    onEvent: params.onEvent,
    onOutputEvent: params.onOutputEvent,
  });
}
