import {
  rankRetentionGroups,
  rankRetentionGroupsForRecovery,
  scoreGraphAwareGroups,
  type GraphAwareWeightSet,
  selectGroupsToByteTarget,
  type RetentionPolicyName,
  type SessionRetentionGroup,
} from "./graph-aware-ranking.js";

export const POLICY_INDEPENDENT_EVALUATION_WEIGHTS: GraphAwareWeightSet = {
  name: "uniform-policy-independent-v1",
  weights: {
    activityRecency: 1 / 7,
    accessRecency: 1 / 7,
    lineageCentrality: 1 / 7,
    directFanout: 1 / 7,
    descendantReach: 1 / 7,
    generationContinuity: 1 / 7,
    transcriptEvidence: 1 / 7,
  },
};

export type PolicyIndependentValueByCostBaseline = {
  first10Percent: number;
  first25Percent: number;
  first50Percent: number;
};

export type RetentionPolicyMetrics = {
  policy: RetentionPolicyName;
  targetBytes: number;
  actualBytesSelected: number;
  ownershipGroupsSelected: number;
  sessionsSelected: number;
  policyIndependentValuePreserved: number;
  policyIndependentDependencyWeightedValuePreserved: number;
  policyIndependentHighValueGroupsPreserved: number;
  protectedGroupViolations: number;
  ownershipGroupSplits: number;
  selectedGroupIds: string[];
};

const METRIC_PRECISION = 9;

function roundMetric(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(METRIC_PRECISION)) : 0;
}

export function evaluatePolicyIndependentValueByCostBaseline(
  groups: readonly SessionRetentionGroup[],
): PolicyIndependentValueByCostBaseline {
  const ranking = rankRetentionGroupsForRecovery({
    groups,
    weightSet: POLICY_INDEPENDENT_EVALUATION_WEIGHTS,
  });
  const totalCost = ranking.reduce(
    (total, ranked) => total + ranked.score.estimatedRecoveryCost,
    0,
  );
  const valueAtFraction = (fraction: number): number => {
    const budget = totalCost * fraction;
    let spent = 0;
    let value = 0;
    for (const ranked of ranking) {
      if (spent + ranked.score.estimatedRecoveryCost > budget) {
        break;
      }
      spent += ranked.score.estimatedRecoveryCost;
      value += ranked.score.recoveryValue;
    }
    return roundMetric(value);
  };
  return {
    first10Percent: valueAtFraction(0.1),
    first25Percent: valueAtFraction(0.25),
    first50Percent: valueAtFraction(0.5),
  };
}

export function evaluateRetentionPolicy(params: {
  groups: readonly SessionRetentionGroup[];
  policy: RetentionPolicyName;
  targetBytes: number;
  protectedGroupIds?: ReadonlySet<string>;
}): RetentionPolicyMetrics {
  const ranking = rankRetentionGroups({ groups: params.groups, policy: params.policy });
  const selected = selectGroupsToByteTarget(ranking, params.targetBytes);
  const selectedGroupIds = new Set(selected.map((ranked) => ranked.group.groupId));
  const evaluationScores = scoreGraphAwareGroups(
    params.groups,
    POLICY_INDEPENDENT_EVALUATION_WEIGHTS,
  );
  const availableGroups = params.groups.filter((group) => !group.protected);
  const totalEvaluationValue = availableGroups.reduce(
    (total, group) => total + (evaluationScores.get(group.groupId)?.recoveryValue ?? 0),
    0,
  );
  const selectedEvaluationValue = selected.reduce(
    (total, ranked) => total + (evaluationScores.get(ranked.group.groupId)?.recoveryValue ?? 0),
    0,
  );
  const dependencyWeighted = (group: SessionRetentionGroup): number => {
    const score = evaluationScores.get(group.groupId)?.recoveryValue ?? 0;
    return score * (1 + Math.log1p(group.descendantCount + group.forkFanout));
  };
  const totalDependencyWeightedValue = availableGroups.reduce(
    (total, group) => total + dependencyWeighted(group),
    0,
  );
  const selectedDependencyWeightedValue = selected.reduce(
    (total, ranked) => total + dependencyWeighted(ranked.group),
    0,
  );
  const highValueCount = Math.max(1, Math.ceil(availableGroups.length * 0.1));
  const highValueGroups = availableGroups
    .toSorted(
      (left, right) =>
        (evaluationScores.get(right.groupId)?.recoveryValue ?? 0) -
          (evaluationScores.get(left.groupId)?.recoveryValue ?? 0) ||
        left.groupId.localeCompare(right.groupId),
    )
    .slice(0, highValueCount);
  const protectedGroupViolations = selected.filter(
    (ranked) =>
      ranked.group.protected || params.protectedGroupIds?.has(ranked.group.groupId) === true,
  ).length;
  return {
    policy: params.policy,
    targetBytes: Math.max(0, params.targetBytes),
    actualBytesSelected: selected.reduce(
      (total, ranked) => total + ranked.group.reclaimableBytes,
      0,
    ),
    ownershipGroupsSelected: selected.length,
    sessionsSelected: selected.reduce((total, ranked) => total + ranked.group.sessionIds.length, 0),
    policyIndependentValuePreserved: roundMetric(totalEvaluationValue - selectedEvaluationValue),
    policyIndependentDependencyWeightedValuePreserved: roundMetric(
      totalDependencyWeightedValue - selectedDependencyWeightedValue,
    ),
    policyIndependentHighValueGroupsPreserved: highValueGroups.filter(
      (group) => !selectedGroupIds.has(group.groupId),
    ).length,
    protectedGroupViolations,
    ownershipGroupSplits: 0,
    selectedGroupIds: [...selectedGroupIds],
  };
}
