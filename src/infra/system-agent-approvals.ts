// OpenClaw system-agent approval payload kept live until operator decision.
import type { ExecApprovalDecision } from "./exec-approvals.js";

export type SystemAgentApprovalRequestPayload = {
  title: string;
  description: string;
  command: string;
  proposalHash: string;
  allowedDecisions: readonly ExecApprovalDecision[];
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId: string;
  turnSourceChannel?: null;
  turnSourceAccountId?: null;
};

export const SYSTEM_AGENT_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const SYSTEM_AGENT_APPROVAL_DECISIONS = ["allow-once", "deny"] as const;
