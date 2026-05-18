type SubagentDeliveryPath = "steered" | "direct" | "none";

type SubagentAnnounceSteerOutcome =
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" };

export type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  error?: string;
  phases?: SubagentAnnounceDispatchPhaseResult[];
};

type SubagentAnnounceDispatchPhase = "steer-primary" | "direct-primary" | "steer-fallback";

type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  error?: string;
};

export function mapSteerOutcomeToDeliveryResult(
  outcome: SubagentAnnounceSteerOutcome,
): SubagentAnnounceDeliveryResult {
  if (outcome.status === "steered") {
    return {
      delivered: true,
      path: "steered",
      deliveredAt: outcome.deliveredAt,
      enqueuedAt: outcome.enqueuedAt,
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
  steer: () => Promise<SubagentAnnounceSteerOutcome>;
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
      deliveredAt: result.deliveredAt,
      enqueuedAt: result.enqueuedAt,
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
    const primarySteerOutcome = await params.steer();
    const primarySteer = mapSteerOutcomeToDeliveryResult(primarySteerOutcome);
    appendPhase("steer-primary", primarySteer);
    if (primarySteer.delivered) {
      return withPhases(primarySteer);
    }
    if (primarySteerOutcome.status === "dropped") {
      return withPhases(primarySteer);
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

  const fallbackSteerOutcome = await params.steer();
  const fallbackSteer = mapSteerOutcomeToDeliveryResult(fallbackSteerOutcome);
  appendPhase("steer-fallback", fallbackSteer);
  if (fallbackSteer.delivered) {
    return withPhases(fallbackSteer);
  }

  return withPhases(primaryDirect);
}
