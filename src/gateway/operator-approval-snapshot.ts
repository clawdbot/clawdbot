import type { ApprovalSnapshot } from "../../packages/gateway-protocol/src/index.js";
import type { OperatorApprovalRecord } from "./operator-approval-store.js";

/** Project one durable row into the reviewer-safe public approval shape. */
export function projectOperatorApprovalSnapshot(
  record: OperatorApprovalRecord,
  controlUiBasePath: string,
): ApprovalSnapshot | null {
  const common = {
    id: record.id,
    status: record.status,
    presentation: record.presentation,
    urlPath: `${controlUiBasePath}/approve/${encodeURIComponent(record.id)}`,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
  if (record.status === "pending") {
    return common as ApprovalSnapshot;
  }
  if (record.resolvedAtMs === null || record.terminalReason === null) {
    return null;
  }
  const terminal = {
    ...common,
    resolvedAtMs: record.resolvedAtMs,
    reason: record.terminalReason,
  };
  if (record.status === "allowed") {
    if (record.decision !== "allow-once" && record.decision !== "allow-always") {
      return null;
    }
    return { ...terminal, decision: record.decision } as ApprovalSnapshot;
  }
  if (record.status === "denied") {
    return { ...terminal, decision: "deny" } as ApprovalSnapshot;
  }
  return terminal as ApprovalSnapshot;
}
