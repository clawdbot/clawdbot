import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { flowContainsCall, requireFlowScenario } from "./scenario-catalog.test-utils.js";

describe("Slack blocked lifecycle scenario", () => {
  it("invalidates and observes the selected account without waiting for readiness", () => {
    const scenario = requireFlowScenario(readQaScenarioById("slack-blocked-lifecycle-no-restart"));

    expect(scenario.gatewayConfigPatch).toMatchObject({
      channels: {
        slack: {
          accounts: {
            $selectedAccount: { botToken: "xoxb-intentionally-invalid-lifecycle" },
          },
        },
      },
    });
    const flow = JSON.stringify(scenario.execution.flow);
    expect(flow).toContain("transport.accountId");
    expect(flow).toContain("await env.gateway.call('channels.status'");
    expect(flow).toContain("account?.lifecycle === 'blocked'");
    expect(flow).not.toContain("account.accountId === 'default'");
    expect(flowContainsCall(scenario.execution.flow, "waitForCondition")).toBe(true);
    expect(flowContainsCall(scenario.execution.flow, "waitForTransportReady")).toBe(false);
  });
});
