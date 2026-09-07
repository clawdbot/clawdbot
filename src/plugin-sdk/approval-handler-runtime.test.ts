import { describe, expect, it } from "vitest";
import type { SystemAgentApprovalRequest } from "../infra/system-agent-approvals.js";
import {
  buildChannelApprovalResolvedText,
  type ResolvedApprovalView,
} from "./approval-handler-runtime.js";
import {
  buildSystemAgentApprovalResolvedText,
  formatChannelApprovalResolvedLabel,
} from "./approval-runtime.js";

type SystemAgentView = Extract<ResolvedApprovalView, { approvalKind: "system-agent" }>;

function systemAgentView(state: Partial<SystemAgentView> = {}): SystemAgentView {
  return {
    approvalKind: "system-agent",
    approvalId: "system-agent:change",
    phase: "resolved",
    title: "OpenClaw change",
    metadata: [],
    commandText: "restart the Gateway",
    operationSummary: "restart the Gateway",
    decision: "allow-once",
    ...state,
  };
}

const cases: Array<{ state: Partial<SystemAgentView>; label: string; text: string }> = [
  {
    state: {},
    label: "Allowed once",
    text: "✅ OpenClaw change approved. Applying: restart the Gateway",
  },
  {
    state: { decision: "allow-always" },
    label: "Allowed always",
    text: "✅ OpenClaw change approved. Applying: restart the Gateway",
  },
  {
    state: { decision: "deny" },
    label: "Denied",
    text: "❌ OpenClaw change denied. No change was made.",
  },
  {
    state: { applicationStatus: "applied" },
    label: "Applied",
    text: "✅ OpenClaw change approved and applied: restart the Gateway",
  },
  {
    state: { applicationStatus: "not-applied" },
    label: "Not applied",
    text: "⚠️ OpenClaw change approved, but it was not applied. Check the Gateway and retry.",
  },
  {
    state: { decision: "deny", applicationStatus: "not-applied" },
    label: "Not applied",
    text: "❌ OpenClaw change denied. No change was made.",
  },
  {
    state: { decision: "deny", applicationStatus: "applied" },
    label: "Applied",
    text: "❌ OpenClaw change denied. No change was made.",
  },
  {
    state: { decision: "deny", applicationStatus: "applied", terminalStatus: "cancelled" },
    label: "Cancelled",
    text: "⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry.",
  },
];

describe("approval terminal presentation", () => {
  it.each(cases)("preserves rich and prose precedence for $state", ({ state, label, text }) => {
    const view = systemAgentView(state);
    expect(formatChannelApprovalResolvedLabel(view)).toBe(label);
    expect(buildSystemAgentApprovalResolvedText(view)).toBe(text);
  });

  it("keeps decision spelling local without overriding application results", () => {
    const formatDecision = (decision: ResolvedApprovalView["decision"]) => `Decision: ${decision}`;
    expect(formatChannelApprovalResolvedLabel(systemAgentView(), formatDecision)).toBe(
      "Decision: allow-once",
    );
    expect(
      formatChannelApprovalResolvedLabel(
        systemAgentView({ applicationStatus: "not-applied" }),
        formatDecision,
      ),
    ).toBe("Not applied");
  });

  it("uses the resolved event's decision for channel prose", () => {
    const request: SystemAgentApprovalRequest = {
      approvalKind: "system-agent",
      id: "system-agent:change",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "test-session",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    expect(
      buildChannelApprovalResolvedText({
        request,
        resolved: { id: request.id, decision: "deny", ts: 1 },
        view: systemAgentView({ applicationStatus: "applied" }),
      }),
    ).toBe("❌ OpenClaw change denied. No change was made.");
  });
});
