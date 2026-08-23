/**
 * Subagent announcement dispatch strategy.
 *
 * Completion handoff and requester-visible replies use this to choose between
 * steering a subagent and directly delivering a message, with phase evidence.
 */
type SubagentDeliveryPath = "steered" | "direct" | "queued" | "none";
type SubagentAnnounceDeliveryDisposition =
  | "delivered"
  | "session_queued"
  | "intentional_non_delivery"
  | "retryable"
  | "ambiguous"
  | "permanent_failure";
/** Stable reasons an announcement delivery can fail without throwing. */
type SubagentAnnounceDeliveryFailureReason =
  | "completion_handoff_pending"
  | "completion_handoff_unavailable"
  | "generated_media_missing"
  | "message_tool_delivery_missing"
  | "requester_abandoned"
  | "source_owner_changed"
  | "visible_reply_missing";

type SubagentAnnounceSteerOutcome =
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" | "source_owner_changed" };

/** Result of trying to deliver a subagent announcement. */
export type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  /** Direct completion that already sent the yielded requester's visible final. */
  requesterVisibleFinalDelivered?: true;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
  // Stops fallback delivery when ownership changed or another terminal result
  // makes trying a second path unsafe.
  terminal?: boolean;
  disposition?: SubagentAnnounceDeliveryDisposition;
  missingMediaUrls?: string[];
  phases?: SubagentAnnounceDispatchPhaseResult[];
};

type SubagentAnnounceDispatchPhase = "steer-primary" | "direct-primary" | "steer-fallback";

type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
};

/** Converts a steer outcome into the shared delivery result shape. */
function mapSteerOutcomeToDeliveryResult(
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
  if (outcome.status === "source_owner_changed") {
    return {
      delivered: false,
      path: "none",
      reason: "source_owner_changed",
      error: "subagent source lifecycle changed before completion delivery",
      terminal: true,
      disposition: "intentional_non_delivery",
    };
  }
  return {
    delivered: false,
    path: "none",
  };
}

/** Runs the ordered steer/direct announcement delivery strategy. */
export async function runSubagentAnnounceDispatch(params: {
  expectsCompletionMessage: boolean;
  requireDirectDelivery?: boolean;
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
      ...(result.reason ? { reason: result.reason } : {}),
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

  if (params.requireDirectDelivery) {
    // Settle synthesis needs its own delivery turn; steering can inherit a
    // message-tool-only completion turn and silently suppress the final reply.
    const primaryDirect = await params.direct();
    appendPhase("direct-primary", primaryDirect);
    return withPhases(primaryDirect);
  }

  if (!params.expectsCompletionMessage) {
    const primarySteerOutcome = await params.steer();
    const primarySteer = mapSteerOutcomeToDeliveryResult(primarySteerOutcome);
    appendPhase("steer-primary", primarySteer);
    if (primarySteer.delivered) {
      return withPhases(primarySteer);
    }
    if (primarySteer.terminal) {
      return withPhases(primarySteer);
    }
    if (primarySteerOutcome.status === "dropped") {
      return withPhases(primarySteer);
    }

    const primaryDirect = await params.direct();
    appendPhase("direct-primary", primaryDirect);
    return withPhases(primaryDirect);
  }

  // Completion handoff prefers direct delivery first so the completion agent's
  // final visible message wins before falling back to steering.
  const primaryDirect = await params.direct();
  appendPhase("direct-primary", primaryDirect);
  if (
    primaryDirect.delivered ||
    primaryDirect.disposition === "session_queued" ||
    primaryDirect.disposition === "intentional_non_delivery" ||
    primaryDirect.disposition === "ambiguous" ||
    primaryDirect.disposition === "permanent_failure"
  ) {
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
  if (fallbackSteer.terminal) {
    return withPhases(fallbackSteer);
  }

  return withPhases(primaryDirect);
}
