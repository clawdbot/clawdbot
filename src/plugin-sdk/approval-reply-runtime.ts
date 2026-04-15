export {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalReplyDecision,
} from "../infra/exec-approval-reply.js";
export { resolveExecApprovalCommandDisplay } from "../infra/exec-approval-command-display.js";

export function resolveExecApprovalRequestAllowedDecisions(_request: unknown) {
  return ["allow-once", "allow-always", "deny"] as const;
}
