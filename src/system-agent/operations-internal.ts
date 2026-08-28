import type { SystemAgentOperation } from "./operation-types.js";

export const INVALID_CONFIG_SET_MESSAGE =
  "Invalid config path. Check its quoting or escaping and try again.";

export function isInvalidConfigSetOperation(
  operation: SystemAgentOperation,
): operation is Extract<SystemAgentOperation, { kind: "none" }> {
  return operation.kind === "none" && operation.message === INVALID_CONFIG_SET_MESSAGE;
}
