import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "./agent-run-registry.js";

type McpToolApprovalBinding = {
  authority: AgentRunDelegatedAuthority;
  agentId: string;
  toolCallId: string;
  server: string;
  tool: string;
  isActive: () => boolean;
};

// The authoritative owner object, not a copied token/run id, owns this one-shot
// handoff across the local RPC. Separate host processes have no entry and cannot mint.
const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.mcpToolApprovalBindings"),
  () => new WeakMap<AgentRunDelegatedAuthority, Set<McpToolApprovalBinding>>(),
);

export function registerMcpToolApprovalBinding(binding: McpToolApprovalBinding): () => void {
  const owner = getActiveAgentRunDelegatedAuthority(binding.authority.operationalRunInstance);
  if (!owner || !validateAgentRunDelegatedAuthority(binding.authority)) {
    return () => {};
  }
  const entries = bindings.get(owner) ?? new Set<McpToolApprovalBinding>();
  entries.add(binding);
  bindings.set(owner, entries);
  return () => entries.delete(binding);
}

export function takeMcpToolApprovalBinding(
  scope: Omit<McpToolApprovalBinding, "isActive">,
): (() => boolean) | undefined {
  if (!validateAgentRunDelegatedAuthority(scope.authority)) {
    return undefined;
  }
  const owner = getActiveAgentRunDelegatedAuthority(scope.authority.operationalRunInstance);
  const entries = owner && bindings.get(owner);
  const matches = [...(entries ?? [])].filter(
    (entry) =>
      entry.agentId === scope.agentId &&
      entry.toolCallId === scope.toolCallId &&
      entry.server === scope.server &&
      entry.tool === scope.tool,
  );
  if (matches.length !== 1) {
    return undefined;
  }
  const binding = matches[0]!;
  entries!.delete(binding);
  return () => {
    try {
      return (
        validateAgentRunDelegatedAuthority(binding.authority) &&
        binding.isActive() &&
        validateAgentRunDelegatedAuthority(binding.authority) &&
        validateAgentRunDelegatedAuthority(scope.authority)
      );
    } catch {
      return false;
    }
  };
}
