// Human-only arming for delegated OpenClaw changes.
import { hashSystemAgentOperation } from "../agents/tools/system-agent-tool.js";
import { isPersistentSystemAgentOperation, type SystemAgentOperation } from "./operations.js";

type ProposalRef = { current?: string; operation?: SystemAgentOperation };

export function resolvePendingOperatorProposal(
  pending: SystemAgentOperation | null,
  proposalRef: ProposalRef,
): { operation: SystemAgentOperation; hash: string } | null {
  const operation = pending ?? proposalRef.operation;
  if (!operation || !isPersistentSystemAgentOperation(operation)) {
    return null;
  }
  const hash = hashSystemAgentOperation(operation);
  if (proposalRef.current && proposalRef.current !== hash) {
    return null;
  }
  proposalRef.current = hash;
  proposalRef.operation = operation;
  return { operation, hash };
}

export async function resolveOperatorApprovalDecision<T>(params: {
  decision: "allow-once" | "allow-always" | "deny" | null;
  proposalHash: string;
  getProposal: () => { hash: string } | null;
  clear: () => void;
  apply: (message: string) => Promise<T>;
  denied: () => T;
}): Promise<T | null> {
  const proposal = params.getProposal();
  if (!proposal || proposal.hash !== params.proposalHash) {
    return null;
  }
  if (params.decision !== "allow-once") {
    params.clear();
    return params.denied();
  }
  return await params.apply(
    `[operator-approved] Human approved ${params.proposalHash}. Apply exact proposal; approved=true.`,
  );
}
