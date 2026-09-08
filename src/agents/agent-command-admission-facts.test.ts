import { describe, expect, it } from "vitest";
import {
  attachAgentCommandRecoveryAdmissionFacts,
  getAgentCommandAdmissionFacts,
} from "./agent-command-admission-facts.js";

describe("agent command admission facts", () => {
  it("records restart recovery as owner-bound system attribution", () => {
    const runContext = {};
    attachAgentCommandRecoveryAdmissionFacts(runContext);
    expect(getAgentCommandAdmissionFacts(runContext)).toEqual({
      ingress: {
        kind: "recovery",
        boundary: "gateway.main-session-recovery",
        state: "present",
      },
      invoker: {
        state: "present",
        kind: "system",
        rawPrincipalRef: "openclaw.main-session-recovery",
      },
      assurance: [
        {
          kind: "runtime-binding",
          rawEvidenceRef: "gateway.main-session-recovery-owner",
          strength: "boundary-verified",
        },
      ],
    });
    expect(getAgentCommandAdmissionFacts({})).toBeUndefined();
  });
});
