type SubagentDeliveryPath =
  | "queued"
  | "steered"
  | "direct"
  | "direct-fallback"
  | "direct-thread-fallback"
  | "none";

type SubagentAnnounceQueueOutcome = "steered" | "queued" | "none" | "dropped";

export type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  error?: string;
  phases?: SubagentAnnounceDispatchPhaseResult[];
};

type SubagentAnnounceDispatchPhase = "queue-primary" | "direct-primary" | "queue-fallback";

type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  delivered: boolean;
  path: SubagentDeliveryPath;
  error?: string;
};

export function mapQueueOutcomeToDeliveryResult(
  outcome: SubagentAnnounceQueueOutcome,
): SubagentAnnounceDeliveryResult {
  if (outcome === "steered") {
    return {
      delivered: true,
      path: "steered",
    };
  }
  if (outcome === "queued") {
    return {
      delivered: true,
      path: "queued",
    };
  }
  return {
    delivered: false,
    path: "none",
  };
}

export async function runSubagentAnnounceDispatch(params: {
  expectsCompletionMessage: boolean;
  signal?: AbortSignal;
  queue: () => Promise<SubagentAnnounceQueueOutcome>;
  direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult> {
  const phases: SubagentAnnounceDispatchPhaseResult[] = [];
  const appendPhase = (
    phase: SubagentAnnounceDispatchPhase,
    result: SubagentAnnounceDeliveryResult,
  ) => {
    phases.push({
      phase,
      delivered: result.delivered,
      path: result.path,
      error: result.error,
    });
  };
  const withPhases = (result: SubagentAnnounceDeliveryResult): SubagentAnnounceDeliveryResult => ({
    ...result,
    phases,
  });

  if (params.signal?.aborted) {
    return withPhases({
      delivered: false,
      path: "none",
    });
  }

  if (!params.expectsCompletionMessage) {
    const primaryQueueOutcome = await params.queue();
    const primaryQueue = mapQueueOutcomeToDeliveryResult(primaryQueueOutcome);
    appendPhase("queue-primary", primaryQueue);
    if (primaryQueue.delivered) {
      return withPhases(primaryQueue);
    }
    if (primaryQueueOutcome === "dropped") {
      return withPhases(primaryQueue);
    }

    const primaryDirect = await params.direct();
    appendPhase("direct-primary", primaryDirect);
    return withPhases(primaryDirect);
  }

  const primaryDirect = await params.direct();
  appendPhase("direct-primary", primaryDirect);
  if (primaryDirect.delivered) {
    return withPhases(primaryDirect);
  }

  if (params.signal?.aborted) {
    return withPhases(primaryDirect);
  }

  const fallbackQueueOutcome = await params.queue();
  const fallbackQueue = mapQueueOutcomeToDeliveryResult(fallbackQueueOutcome);
  appendPhase("queue-fallback", fallbackQueue);
  if (fallbackQueue.delivered) {
    return withPhases(fallbackQueue);
  }

  return withPhases(primaryDirect);
}
