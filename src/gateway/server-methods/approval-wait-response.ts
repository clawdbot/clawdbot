import type { ExecApprovalDecision } from "../../infra/exec-approvals.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import type { OperatorApprovalTerminalReason } from "../operator-approval-store.js";

export type WaitReasonResolver<TPayload> = (
  snapshot: ExecApprovalRecord<TPayload>,
) => OperatorApprovalTerminalReason | null | undefined;

export function buildWaitResponse<TPayload>(
  id: string,
  decision: ExecApprovalDecision | null,
  snapshot: ExecApprovalRecord<TPayload>,
  terminalReason?: OperatorApprovalTerminalReason | null,
) {
  return {
    id,
    decision,
    createdAtMs: snapshot.createdAtMs,
    expiresAtMs: snapshot.expiresAtMs,
    terminalReason: terminalReason ?? snapshot.terminalReason,
  };
}
