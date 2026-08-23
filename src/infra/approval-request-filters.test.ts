// Covers approval request agent and session filters.
import { describe, expect, it } from "vitest";
import {
  matchesApprovalRequestFilters,
  matchesApprovalRequestSessionFilter,
} from "./approval-request-filters.js";

describe("approval request filters", () => {
  it("matches explicit agent ids and session substrings", () => {
    expect(
      matchesApprovalRequestFilters({
        request: {
          agentId: "ops-agent",
          sessionKey: "agent:ops-agent:slack:direct:U1:tail",
        },
        agentFilter: ["ops-agent"],
        sessionFilter: ["slack:direct:", "tail$"],
      }),
    ).toBe(true);
  });

  it("can fall back to the session-key agent id", () => {
    expect(
      matchesApprovalRequestFilters({
        request: {
          sessionKey: "agent:ops-agent:telegram:group:-1001",
        },
        agentFilter: ["ops-agent"],
        fallbackAgentIdFromSessionKey: true,
      }),
    ).toBe(true);
    expect(
      matchesApprovalRequestFilters({
        request: {
          sessionKey: "agent:ops-agent:telegram:group:-1001",
        },
        agentFilter: ["ops-agent"],
      }),
    ).toBe(false);
  });

  it("rejects unsafe regex patterns in session filters", () => {
    expect(matchesApprovalRequestSessionFilter(`${"a".repeat(28)}!`, ["(a+)+$"])).toBe(false);
  });
});
