import { describe, expect, it } from "vitest";
// @vitest-environment node
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { classifyRunInspection } from "./run-inspector-model.ts";

function unavailable(
  state: "unknown" | "unsupported" | "ambiguous",
  reasonCode: string,
  remediation: Array<{ code: string; text: string }> = [],
): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
    identity:
      state === "ambiguous"
        ? {
            state,
            reasonCode,
            candidates: [],
            missingEvidence: ["execution.selection"],
            remediation,
          }
        : {
            state,
            reasonCode,
            missingEvidence: ["identity.context"],
            remediation,
          },
    decisions: [],
    coverage: { state: state === "ambiguous" ? "unknown" : state, missingEvidence: [] },
  };
}

describe("classifyRunInspection", () => {
  it.each([
    [unavailable("unknown", "run_not_found"), "not-found"],
    [unavailable("unknown", "identity_context_corrupt"), "corrupt"],
    [
      unavailable("unsupported", "identity_context_unavailable", [
        { code: "run_again_after_expiry", text: "Run again." },
      ]),
      "expired",
    ],
    [unavailable("unsupported", "identity_context_unavailable"), "unsupported"],
    [unavailable("unknown", "run_evidence_unreadable"), "unknown"],
    [unavailable("ambiguous", "execution_selection_required"), "ambiguous"],
  ] as const)("classifies the authoritative diagnostic result as %s", (result, expected) => {
    expect(classifyRunInspection(result)).toBe(expected);
  });
});
