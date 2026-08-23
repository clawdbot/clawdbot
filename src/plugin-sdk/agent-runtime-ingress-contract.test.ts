import { describe, expect, it } from "vitest";
import { agentCommandFromIngress } from "./agent-runtime.js";

type PublicIngressOptions = Parameters<typeof agentCommandFromIngress>[0];
const optionalRunIdCaller: PublicIngressOptions = {
  message: "hello",
  sessionKey: "agent:main:plugin-session",
  allowModelOverride: false,
};
const privateRecoveryCorrelationIsHidden: "executionIdentityAdmission" extends keyof PublicIngressOptions
  ? false
  : true = true;

describe("public agent ingress correlation contract", () => {
  it("keeps runId optional and private execution recovery state unavailable", () => {
    expect(optionalRunIdCaller).not.toHaveProperty("runId");
    expect(privateRecoveryCorrelationIsHidden).toBe(true);
  });
});
