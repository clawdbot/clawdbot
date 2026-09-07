import type { ResolvedApprovalView } from "../infra/approval-view-model.types.js";

type SystemAgentResolvedView = Extract<ResolvedApprovalView, { approvalKind: "system-agent" }>;
type ApprovalTerminalOutcome =
  | ResolvedApprovalView["decision"]
  | "cancelled"
  | "applied"
  | "not-applied";

const TERMINAL_LABELS = {
  "allow-once": "Allowed once",
  "allow-always": "Allowed always",
  deny: "Denied",
  cancelled: "Cancelled",
  applied: "Applied",
  "not-applied": "Not applied",
};

/** Label a recorded decision without implying that a system change was applied. */
export function formatApprovalDecisionLabel(decision: ResolvedApprovalView["decision"]): string {
  return TERMINAL_LABELS[decision];
}

function interpretApprovalTerminalOutcome(
  view: ResolvedApprovalView,
  precedence: "application" | "denial",
): ApprovalTerminalOutcome {
  if (view.approvalKind !== "system-agent") {
    return view.decision;
  }
  if (view.terminalStatus === "cancelled") {
    return "cancelled";
  }
  // Denied changes also publish not-applied. Preserve rich-label and prose precedence.
  return precedence === "denial" && view.decision === "deny"
    ? "deny"
    : (view.applicationStatus ?? view.decision);
}

/** Format a rich terminal label, retaining transport-specific decision spelling. */
export function formatChannelApprovalResolvedLabel(
  view: ResolvedApprovalView,
  formatDecision?: (decision: ResolvedApprovalView["decision"]) => string,
): string {
  const outcome = interpretApprovalTerminalOutcome(view, "application");
  return formatDecision && outcome === view.decision
    ? formatDecision(view.decision)
    : TERMINAL_LABELS[outcome];
}

/** Describe a system change using denial-first prose and a prepared operation summary. */
export function buildSystemAgentApprovalResolvedText(view: SystemAgentResolvedView): string {
  const outcome = interpretApprovalTerminalOutcome(view, "denial");
  return outcome === "cancelled"
    ? "⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry."
    : outcome === "deny"
      ? "❌ OpenClaw change denied. No change was made."
      : outcome === "applied"
        ? `✅ OpenClaw change approved and applied: ${view.operationSummary}`
        : outcome === "not-applied"
          ? "⚠️ OpenClaw change approved, but it was not applied. Check the Gateway and retry."
          : `✅ OpenClaw change approved. Applying: ${view.operationSummary}`;
}
