// Human-only arming for delegated OpenClaw changes.
import { hashSystemAgentOperation } from "../agents/tools/system-agent-tool.js";
import { isPersistentSystemAgentOperation, type SystemAgentOperation } from "./operations.js";

type ProposalRef = { current?: string; operation?: SystemAgentOperation };

export type SystemAgentApprovalIntent = "approve" | "decline" | "other";

const APPROVE_RE =
  /^(?:y|yes|yeah|yep|yup|sure|ok|okay|approve|approved|apply|confirm|confirmed|do it|go ahead|sounds good|yes please|please do)$/i;
const DECLINE_RE = /^(?:n|no|nope|nah|skip|not now|cancel|stop|abort|later|decline|don'?t)\b/i;

/** Deterministic whole-message approvals and prefix declines. */
export function classifySystemAgentApprovalText(message: string): SystemAgentApprovalIntent {
  const normalized = message
    .trim()
    .replace(/[.!?,\s]+$/u, "")
    .toLowerCase();
  if (!normalized) {
    return "other";
  }
  if (APPROVE_RE.test(normalized)) {
    return "approve";
  }
  if (DECLINE_RE.test(normalized)) {
    return "decline";
  }
  return "other";
}

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
  getProposal: () => { operation: SystemAgentOperation; hash: string } | null;
  clear: () => void;
  apply: (operation: SystemAgentOperation) => Promise<T>;
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
  // Consume authority before applying so duplicate callbacks and failures
  // cannot replay an already-approved operation.
  params.clear();
  return await params.apply(proposal.operation);
}
