import { describe, expect, it } from "vitest";
import { resolveClawToolPolicyConsent } from "./tool-policy-runtime.js";

describe("resolveClawToolPolicyConsent", () => {
  it("leaves ordinary non-Claw profiles dynamic", () => {
    const tools = { profile: "coding" };
    expect(
      resolveClawToolPolicyConsent({
        agentTools: tools,
        agentId: "worker",
        profile: "coding",
        ownsProfile: true,
        hasAgentAllowlist: false,
      }),
    ).toEqual({ frozen: false });
  });

  it("does not treat an inherited global profile as Claw-owned authority", () => {
    expect(
      resolveClawToolPolicyConsent({
        agentId: "worker",
        profile: "coding",
        ownsProfile: false,
        hasAgentAllowlist: false,
      }),
    ).toEqual({ frozen: false });
  });
});
