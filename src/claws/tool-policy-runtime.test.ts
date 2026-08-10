import { beforeEach, describe, expect, it, vi } from "vitest";

const provenance = vi.hoisted(() => ({
  record: undefined as { schemaVersion: string } | undefined,
}));

vi.mock("./provenance-runtime-read.js", () => ({
  readExistingClawInstallRecordSync: () => provenance.record,
}));

import { resolveClawToolPolicyConsent } from "./tool-policy-runtime.js";

describe("resolveClawToolPolicyConsent", () => {
  beforeEach(() => {
    provenance.record = undefined;
  });

  it("leaves ordinary non-Claw profiles dynamic", () => {
    expect(
      resolveClawToolPolicyConsent({
        agentId: "worker",
        profile: "coding",
        ownsProfile: true,
        hasAgentAllowlist: false,
      }),
    ).toEqual({ frozen: false });
  });

  it("fails closed for legacy Claw profile provenance", () => {
    provenance.record = { schemaVersion: "openclaw.clawInstallRecord.v1" };

    expect(() =>
      resolveClawToolPolicyConsent({
        agentId: "worker",
        profile: "coding",
        ownsProfile: true,
        hasAgentAllowlist: false,
      }),
    ).toThrow("uses a legacy dynamic tool policy");
  });

  it("marks current Claw profile provenance as frozen", () => {
    provenance.record = { schemaVersion: "openclaw.clawInstallRecord.v2" };

    expect(
      resolveClawToolPolicyConsent({
        agentId: "worker",
        profile: "full",
        ownsProfile: true,
        hasAgentAllowlist: true,
      }),
    ).toEqual({ frozen: true });
  });

  it("does not treat an inherited global profile as Claw-owned authority", () => {
    provenance.record = { schemaVersion: "openclaw.clawInstallRecord.v2" };

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
