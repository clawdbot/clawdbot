import { describe, expect, it } from "vitest";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";

function requireProbeFailure(findings: ReturnType<typeof collectDeepProbeFindings>) {
  const finding = findings.find((entry) => entry.checkId === "gateway.probe_failed");
  if (!finding) {
    throw new Error("Expected gateway probe failure finding");
  }
  return finding;
}

describe("security audit deep probe failure", () => {
  it("adds probe_failed warnings for deep probe failure modes", () => {
    const cases: Array<{
      name: string;
      deep: {
        gateway: {
          attempted: boolean;
          url: string | null;
          ok: boolean;
          error: string | null;
          close?: { code: number; reason: string } | null;
        };
      };
      expectedError: string;
    }> = [
      {
        name: "probe returns failed result",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "connect failed",
            close: null,
          },
        },
        expectedError: "connect failed",
      },
      {
        name: "probe throws",
        deep: {
          gateway: {
            attempted: true,
            ok: false,
            url: "ws://127.0.0.1:18789",
            error: "probe boom",
            close: null,
          },
        },
        expectedError: "probe boom",
      },
    ];

    for (const testCase of cases) {
      const findings = collectDeepProbeFindings({ deep: testCase.deep });
      const probeFailure = requireProbeFailure(findings);
      expect(probeFailure.detail, testCase.name).toContain(testCase.expectedError);
    }
  });
});
