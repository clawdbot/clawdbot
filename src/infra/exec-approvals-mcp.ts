import { loadExecApprovalsReadOnly } from "./exec-approvals-store.js";
import type { McpToolGrant } from "./exec-approvals.types.js";

export type { McpToolGrant } from "./exec-approvals.types.js";

/** Snapshot exact-agent grants at thread/registration preparation, never on tool calls. */
export function loadMcpToolGrants(agentId: string): readonly McpToolGrant[] {
  return agentId === "*" ? [] : (loadExecApprovalsReadOnly().agents?.[agentId]?.mcpTools ?? []);
}
