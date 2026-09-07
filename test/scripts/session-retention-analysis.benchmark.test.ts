import { expect, it } from "vitest";
import { runRetentionBenchmark } from "../../scripts/session-retention-analysis/benchmark.js";
import {
  BALANCED_GRAPH_WEIGHTS,
  PRIMARY_GRAPH_WEIGHTS,
} from "../../scripts/session-retention-analysis/graph-aware-ranking.js";
import { POLICY_INDEPENDENT_EVALUATION_WEIGHTS } from "../../scripts/session-retention-analysis/metrics.js";

function deterministicMetrics(report: Awaited<ReturnType<typeof runRetentionBenchmark>>) {
  return report.workloads.map((workload) => ({
    workload: workload.workload,
    targetBytes: workload.targetBytes,
    policyIndependentValueByCostBaseline: workload.policyIndependentValueByCostBaseline,
    inputCounts: workload.inputCounts,
    policies: workload.policies.map(
      ({ runtimeMs: _runtimeMs, heapDeltaBytes: _heapDelta, ...policy }) => policy,
    ),
    invariants: workload.invariants,
  }));
}

function retentionEnvironment() {
  return {
    stateDir: process.env.OPENCLAW_STATE_DIR,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    agentDir: process.env.OPENCLAW_AGENT_DIR,
  };
}

it("runs every temporary-store workload without mutations, splits, or protection violations", async () => {
  const environmentBefore = retentionEnvironment();
  const report = await runRetentionBenchmark({
    mode: "smoke",
    groupsPerWorkload: 4,
    writeArtifact: false,
  });

  expect(report.workloads).toHaveLength(5);
  expect(report.invariants).toEqual({
    activeSessionPlanViolations: 0,
    activeSessionRankingViolations: 0,
    protectedGroupViolations: 0,
    ownershipGroupSplits: 0,
    actualMutations: 0,
  });
  expect(
    report.workloads.every(
      (workload) =>
        workload.inputCounts.activeSessionFixtures === 1 &&
        workload.inputCounts.activeSessionControlCandidates === 1,
    ),
  ).toBe(true);
  expect(
    report.workloads.every(
      (workload) =>
        Object.values(workload.policyIndependentValueByCostBaseline).every(Number.isFinite) &&
        workload.policies.every((policy) => !("policyIndependentValueByCost" in policy)),
    ),
  ).toBe(true);
  expect(
    report.workloads.every(
      (workload) =>
        workload.invariants.activeSessionPlanViolations === 0 &&
        workload.invariants.activeSessionRankingViolations === 0 &&
        workload.policies.every((policy) => policy.protectedGroupViolations === 0),
    ),
  ).toBe(true);
  expect(report.workloads.every((workload) => workload.invariants.isolatedStateDirectory)).toBe(
    true,
  );
  expect(report.rankingWeightSets).toEqual([PRIMARY_GRAPH_WEIGHTS, BALANCED_GRAPH_WEIGHTS]);
  expect(report.evaluationWeightSet).toEqual(POLICY_INDEPENDENT_EVALUATION_WEIGHTS);
  expect(report.evaluationWeightSet.weights).not.toEqual(PRIMARY_GRAPH_WEIGHTS.weights);
  expect(report.evaluationWeightSet.weights).not.toEqual(BALANCED_GRAPH_WEIGHTS.weights);
  expect(JSON.stringify(report)).not.toMatch(/[A-Z]:\\Users\\/u);
  expect(retentionEnvironment()).toEqual(environmentBefore);
});

it("produces identical policy metrics from independently created fixtures", async () => {
  const first = await runRetentionBenchmark({
    mode: "smoke",
    groupsPerWorkload: 4,
    writeArtifact: false,
  });
  const second = await runRetentionBenchmark({
    mode: "smoke",
    groupsPerWorkload: 4,
    writeArtifact: false,
  });

  expect(deterministicMetrics(second)).toEqual(deterministicMetrics(first));
});
