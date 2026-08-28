import type {
  HealthCheckContext,
  HealthFinding,
  HealthRepairContext,
  HealthRepairResult,
} from "openclaw/plugin-sdk/health";
import { describe, expect, it, vi } from "vitest";
import { createPolicyScopedChecks } from "./check-factory.js";
import { CHECK_IDS } from "./check-ids.js";
import type { PolicyEvaluation } from "./types.js";

describe("policy scoped health checks", () => {
  const evaluation = {} as PolicyEvaluation;
  const context = {} as HealthCheckContext;

  it("preserves registration order, descriptions, metadata, and repair capability", () => {
    const repair = vi.fn(async (): Promise<HealthRepairResult> => ({ changes: [] }));
    const checks = createPolicyScopedChecks(
      {
        evaluatePolicy: vi.fn(async () => evaluation),
        findingsForCheck: vi.fn(() => []),
      },
      [
        [CHECK_IDS.policyMissingFile, "The policy file exists."],
        [CHECK_IDS.policyDeniedChannelProvider, "Channels satisfy policy.", repair],
      ],
    );

    expect(
      checks.map(({ id, description, kind, source }) => ({ id, description, kind, source })),
    ).toEqual([
      {
        id: CHECK_IDS.policyMissingFile,
        description: "The policy file exists.",
        kind: "plugin",
        source: "policy",
      },
      {
        id: CHECK_IDS.policyDeniedChannelProvider,
        description: "Channels satisfy policy.",
        kind: "plugin",
        source: "policy",
      },
    ]);
    expect(Object.hasOwn(checks[0]!, "repair")).toBe(false);
    expect(Object.hasOwn(checks[1]!, "repair")).toBe(true);
    expect(checks[1]).toMatchObject({ repair });
  });

  it("awaits the policy evaluation before selecting findings for the same check", async () => {
    const findings: HealthFinding[] = [
      { checkId: CHECK_IDS.policyMissingFile, severity: "error", message: "Missing policy." },
    ];
    let releaseEvaluation!: () => void;
    const evaluationGate = new Promise<void>((resolve) => {
      releaseEvaluation = resolve;
    });
    const evaluatePolicy = vi.fn(async (received: HealthCheckContext) => {
      expect(received).toBe(context);
      await evaluationGate;
      return evaluation;
    });
    const findingsForCheck = vi.fn(() => findings);
    const [check] = createPolicyScopedChecks({ evaluatePolicy, findingsForCheck }, [
      [CHECK_IDS.policyMissingFile, "The policy file exists."],
    ]);

    const result = check!.detect(context);
    expect(evaluatePolicy).toHaveBeenCalledOnce();
    expect(findingsForCheck).not.toHaveBeenCalled();

    releaseEvaluation();
    await expect(result).resolves.toBe(findings);
    expect(findingsForCheck).toHaveBeenCalledExactlyOnceWith(
      evaluation,
      CHECK_IDS.policyMissingFile,
    );
  });

  it("propagates evaluation failures without selecting findings", async () => {
    const failure = new Error("policy evaluation failed");
    const evaluatePolicy = vi.fn(async () => {
      throw failure;
    });
    const findingsForCheck = vi.fn(() => []);
    const [check] = createPolicyScopedChecks({ evaluatePolicy, findingsForCheck }, [
      [CHECK_IDS.policyMissingFile, "The policy file exists."],
    ]);

    await expect(check!.detect(context)).rejects.toBe(failure);
    expect(findingsForCheck).not.toHaveBeenCalled();
  });

  it("retains the original repair callback and its exact result promise", () => {
    const repairContext = {} as HealthRepairContext;
    const findings: HealthFinding[] = [];
    const pendingRepair = Promise.resolve<HealthRepairResult>({ changes: ["repaired"] });
    const repair = vi.fn(() => pendingRepair);
    const [check] = createPolicyScopedChecks(
      {
        evaluatePolicy: vi.fn(async () => evaluation),
        findingsForCheck: vi.fn(() => []),
      },
      [[CHECK_IDS.policyDeniedChannelProvider, "Channels satisfy policy.", repair]],
    );

    expect(check).toMatchObject({ repair });
    expect(check!.repair!(repairContext, findings)).toBe(pendingRepair);
    expect(repair).toHaveBeenCalledExactlyOnceWith(repairContext, findings);
  });
});
