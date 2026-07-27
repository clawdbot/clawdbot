/**
 * Tests system-run approval binding and request identity propagation.
 */
import { describe, expect, test } from "vitest";
import { toSystemRunApprovalMismatchError } from "../infra/system-run-approval-binding.js";

describe("toSystemRunApprovalMismatchError", () => {
  test("includes runId/code and preserves mismatch details", () => {
    const result = toSystemRunApprovalMismatchError({
      runId: "approval-123",
      match: {
        ok: false,
        code: "APPROVAL_ENV_MISMATCH",
        message: "approval id env binding mismatch",
        details: {
          envKeys: ["SAFE_A"],
          expectedEnvHash: "expected-hash",
          actualEnvHash: "actual-hash",
        },
      },
    });
    expect(result).toEqual({
      ok: false,
      message: "approval id env binding mismatch",
      details: {
        code: "APPROVAL_ENV_MISMATCH",
        runId: "approval-123",
        envKeys: ["SAFE_A"],
        expectedEnvHash: "expected-hash",
        actualEnvHash: "actual-hash",
      },
    });
  });
});
