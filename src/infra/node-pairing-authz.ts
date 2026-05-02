import { NODE_SYSTEM_RUN_COMMANDS } from "./node-commands.js";

export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";

const OPERATOR_PAIRING_SCOPE: NodeApprovalScope = "operator.pairing";
const OPERATOR_WRITE_SCOPE: NodeApprovalScope = "operator.write";
const OPERATOR_ADMIN_SCOPE: NodeApprovalScope = "operator.admin";

export function resolveNodePairApprovalScopes(commands: unknown): NodeApprovalScope[] {
  const normalized = Array.isArray(commands)
    ? commands.filter((command): command is string => typeof command === "string")
    : [];
  if (
    normalized.some((command) => NODE_SYSTEM_RUN_COMMANDS.some((allowed) => allowed === command))
  ) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_ADMIN_SCOPE];
  }
  if (normalized.length > 0) {
    return [OPERATOR_PAIRING_SCOPE, OPERATOR_WRITE_SCOPE];
  }
  return [OPERATOR_PAIRING_SCOPE];
}
