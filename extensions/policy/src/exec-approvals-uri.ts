// Stable policy-finding URI identity that intentionally survives the SQLite migration.
// This names locations inside the approvals document; it is not a filesystem path.
export const EXEC_APPROVALS_POLICY_URI = "oc://exec-approvals.json";
export const EXEC_APPROVALS_POLICY_DOCUMENT_NAME = EXEC_APPROVALS_POLICY_URI.slice("oc://".length);

export function execApprovalsPolicyUri(relativePath?: string): string {
  return relativePath ? `${EXEC_APPROVALS_POLICY_URI}/${relativePath}` : EXEC_APPROVALS_POLICY_URI;
}
