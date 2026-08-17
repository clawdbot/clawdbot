import { describe, expect, it } from "vitest";
import {
  CRITICAL_APPLY_CONTRACT_VERSION,
  type CriticalApplyTransaction,
  ZERO_CRITICAL_APPLY_SIDE_EFFECTS,
} from "./contracts.js";
import {
  assertOnlyZeroCriticalApplySideEffects,
  assertValidCriticalApplyTransactionShape,
  CRITICAL_APPLY_ZERO_SIDE_EFFECT_ERROR,
  validateCriticalApplyTransactionShape,
} from "./validators.js";

function validTransaction(
  overrides: Partial<CriticalApplyTransaction> = {},
): CriticalApplyTransaction {
  return {
    schema: CRITICAL_APPLY_CONTRACT_VERSION,
    id: "m10-fixture",
    disabledByDefault: true,
    terminal: "PASS",
    sourceAuthority: {
      repo: "https://github.com/openclaw/openclaw.git",
      commit: "eeef4864494f859838fec1586bedbab1f8fa5702",
      tree: "1b7a4b7a7341497f3c5b441ece5d3b93111630a0",
      packageName: "openclaw",
      packageVersion: "2026.5.7",
    },
    targetAuthority: {
      targetRoot: "/example/target/root",
      packageRoot: "/example/target/root/lib/node_modules/openclaw",
      binPath: "/example/target/root/bin/openclaw",
    },
    restorePoint: {
      path: "/example/restore-point",
      sha256: "abc123",
      createdAt: "2026-08-17T07:17:00.000Z",
      maxAgeSeconds: 3600,
    },
    rollbackPlanPath: "/example/rollback.json",
    maintenanceLockPath: "/example/critical-apply.lock",
    precheckReceiptPath: "/example/precheck.json",
    postcheckReceiptPath: "/example/postcheck.json",
    watcher: {
      id: "watcher-1",
      kind: "independent-check",
      receiptPath: "/example/watcher.json",
    },
    sideEffects: ZERO_CRITICAL_APPLY_SIDE_EFFECTS,
    ...overrides,
  };
}

describe("Critical Apply contract validators", () => {
  it.each(["PASS", "HOLD", "FAIL", "ABORT"] as const)("accepts %s terminal", (terminal) => {
    expect(validateCriticalApplyTransactionShape(validTransaction({ terminal }))).toEqual([]);
  });

  it("requires disabled-by-default transactions", () => {
    const tx = validTransaction({ disabledByDefault: false as true });
    expect(validateCriticalApplyTransactionShape(tx)).toContain("disabledByDefault must be true");
  });

  it("rejects non-zero side-effect counters", () => {
    expect(() =>
      assertOnlyZeroCriticalApplySideEffects({
        ...ZERO_CRITICAL_APPLY_SIDE_EFFECTS,
        productionMutations: 1,
      }),
    ).toThrow(CRITICAL_APPLY_ZERO_SIDE_EFFECT_ERROR);
  });

  it("requires source, target, restore, rollback, lock, precheck, postcheck, and watcher fields", () => {
    const tx = validTransaction({
      sourceAuthority: { repo: "", commit: "", tree: "" },
      targetAuthority: { targetRoot: "" },
      restorePoint: { path: "", sha256: "", createdAt: "", maxAgeSeconds: 3600 },
      rollbackPlanPath: "",
      maintenanceLockPath: "",
      precheckReceiptPath: "",
      postcheckReceiptPath: "",
      watcher: { id: "", kind: "independent-check" },
    });
    expect(validateCriticalApplyTransactionShape(tx)).toEqual(
      expect.arrayContaining([
        "sourceAuthority.repo is required",
        "sourceAuthority.commit is required",
        "sourceAuthority.tree is required",
        "targetAuthority.targetRoot is required",
        "restorePoint.path is required",
        "restorePoint.sha256 is required",
        "rollbackPlanPath is required",
        "maintenanceLockPath is required",
        "precheckReceiptPath is required",
        "postcheckReceiptPath is required",
        "watcher.id is required",
      ]),
    );
  });

  it("throws a combined validation error for malformed transactions", () => {
    expect(() => assertValidCriticalApplyTransactionShape(validTransaction({ id: "" }))).toThrow(
      "Invalid Critical Apply transaction: id is required",
    );
  });
});
