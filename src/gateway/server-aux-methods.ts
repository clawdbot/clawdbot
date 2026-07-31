// Auxiliary gateway methods are exposed outside the primary chat/session method
// list for approval and secret-management flows that need their own scopes.
/** Gateway method ids handled by auxiliary approval/secret surfaces. */
export const GATEWAY_AUX_METHODS = [
  "exec.approval.get",
  "exec.approval.list",
  "exec.approval.request",
  "exec.approval.waitDecision",
  "exec.approval.resolve",
  "plugin.approval.list",
  "plugin.approval.request",
  "plugin.approval.waitDecision",
  "plugin.approval.resolve",
  "approval.get",
  "approval.history",
  "approval.resolve",
  "question.request",
  "question.waitAnswer",
  "question.resolve",
  "question.get",
  "question.list",
  "secrets.reload",
  "secrets.resolve",
] as const;
