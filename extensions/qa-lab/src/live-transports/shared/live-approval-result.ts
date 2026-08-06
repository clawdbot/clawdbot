export function formatApprovalResultValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "<missing>";
  }
  return JSON.stringify(value) ?? "<unserializable>";
}

function readAcceptedApprovalRequest(result: unknown) {
  const accepted =
    typeof result === "object" && result !== null
      ? (result as { id?: unknown; status?: unknown })
      : null;
  if (accepted?.status !== "accepted") {
    throw new Error(
      `approval request status was ${formatApprovalResultValue(
        accepted?.status,
      )} instead of accepted`,
    );
  }
  return accepted;
}

export function readAcceptedApprovalRequestId(result: unknown) {
  const id = readAcceptedApprovalRequest(result).id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`approval request id was ${formatApprovalResultValue(id)}`);
  }
  return id;
}

export function assertApprovalDecisionResult(params: { decision: string; result: unknown }) {
  const resultDecision =
    typeof params.result === "object" && params.result !== null
      ? (params.result as { decision?: unknown }).decision
      : undefined;
  if (resultDecision !== params.decision) {
    throw new Error(
      `approval decision was ${formatApprovalResultValue(resultDecision)} instead of ${params.decision}`,
    );
  }
}
