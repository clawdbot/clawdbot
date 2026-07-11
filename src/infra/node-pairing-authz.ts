// Maps node pairing command declarations to required operator scopes.
import { NODE_BROWSER_PROXY_COMMAND, NODE_SYSTEM_RUN_COMMANDS } from "./node-commands.js";

/** Operator scopes required to approve a pending node pairing surface. */
export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";

const OPERATOR_PAIRING_SCOPE: NodeApprovalScope = "operator.pairing";
const OPERATOR_WRITE_SCOPE: NodeApprovalScope = "operator.write";
const OPERATOR_ADMIN_SCOPE: NodeApprovalScope = "operator.admin";

const ADMIN_APPROVAL_COMMANDS = [...NODE_SYSTEM_RUN_COMMANDS, NODE_BROWSER_PROXY_COMMAND];

/** Map declared node commands to the least operator scopes needed for approval. */
export function resolveNodePairApprovalScopes(commands: unknown): NodeApprovalScope[] {
  const normalized = Array.isArray(commands)
    ? commands.filter((command): command is string => typeof command === "string")
    : [];
  if (
    normalized.some((command) => ADMIN_APPROVAL_COMMANDS.some((allowed) => allowed === command))
  ) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_ADMIN_SCOPE];
  }
  if (normalized.length > 0) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_WRITE_SCOPE];
  }
  return [OPERATOR_PAIRING_SCOPE];
}
