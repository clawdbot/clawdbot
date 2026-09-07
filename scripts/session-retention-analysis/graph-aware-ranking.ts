type SessionRetentionEvidence = {
  hasAccessMetadata: boolean;
  hasLineageMetadata: boolean;
  hasSizeMetadata: boolean;
};

export type SessionRetentionGroup = {
  groupId: string;
  sessionKeys: string[];
  sessionIds: string[];
  existingOrder: number;
  reclaimableBytes: number;
  transcriptEventCount: number;
  parentLinkedEventCount: number;
  generationCount: number;
  generationLinkCount: number;
  updatedAt: number | null;
  lastReadAt: number | null;
  lastInteractionAt: number | null;
  lastActivityAt: number | null;
  parentGroupIds: string[];
  childGroupIds: string[];
  previousGenerationGroupIds: string[];
  forkSourceGroupIds: string[];
  directChildCount: number;
  descendantCount: number;
  forkFanout: number;
  protected: boolean;
  protectionReasons: string[];
  evidence: SessionRetentionEvidence;
};

type GraphAwareFeature =
  | "activityRecency"
  | "accessRecency"
  | "lineageCentrality"
  | "directFanout"
  | "descendantReach"
  | "generationContinuity"
  | "transcriptEvidence";

export type GraphAwareWeightSet = Readonly<{
  name: string;
  weights: Readonly<Record<GraphAwareFeature, number>>;
}>;

export type GraphAwareScore = {
  recoveryValue: number;
  estimatedRecoveryCost: number;
  evictionPriority: number;
  recoveryPriority: number;
  contributions: Array<{
    feature: GraphAwareFeature;
    rawValue: number;
    normalizedValue: number;
    weight: number;
    contribution: number;
  }>;
};

export type RetentionPolicyName =
  | "existing-order"
  | "least-recently-active"
  | "size-first"
  | "graph-aware"
  | "graph-aware-balanced";

export type RankedRetentionGroup = {
  group: SessionRetentionGroup;
  score: GraphAwareScore;
};

export const PRIMARY_GRAPH_WEIGHTS: GraphAwareWeightSet = {
  name: "relationship-forward-v1",
  weights: {
    activityRecency: 0.2,
    accessRecency: 0.1,
    lineageCentrality: 0.14,
    directFanout: 0.16,
    descendantReach: 0.16,
    generationContinuity: 0.14,
    transcriptEvidence: 0.1,
  },
};

export const BALANCED_GRAPH_WEIGHTS: GraphAwareWeightSet = {
  name: "recency-balanced-v1",
  weights: {
    activityRecency: 0.28,
    accessRecency: 0.16,
    lineageCentrality: 0.1,
    directFanout: 0.1,
    descendantReach: 0.1,
    generationContinuity: 0.14,
    transcriptEvidence: 0.12,
  },
};

const FEATURE_ORDER: GraphAwareFeature[] = [
  "activityRecency",
  "accessRecency",
  "lineageCentrality",
  "directFanout",
  "descendantReach",
  "generationContinuity",
  "transcriptEvidence",
];

const MISSING_METADATA_NORMALIZED_VALUE = 0.5;
const SCORE_PRECISION = 12;

function roundScore(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(SCORE_PRECISION)) : 0;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function finiteTimestamp(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function latestTimestamp(values: readonly (number | null)[]): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const timestamp = finiteTimestamp(value);
    if (timestamp !== null && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

/**
 * Cleanup recency fallback: activity, interaction, access, then node update.
 * A missing value does not become an infinitely old timestamp.
 */
function resolveLeastRecentActivityAt(group: SessionRetentionGroup): number | null {
  return (
    finiteTimestamp(group.lastActivityAt) ??
    finiteTimestamp(group.lastInteractionAt) ??
    finiteTimestamp(group.lastReadAt) ??
    finiteTimestamp(group.updatedAt)
  );
}

function normalizeFeature(
  values: readonly (number | null)[],
  missingValue = MISSING_METADATA_NORMALIZED_VALUE,
): number[] {
  const finiteValues = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (finiteValues.length === 0) {
    return values.map(() => missingValue);
  }
  const minimum = Math.min(...finiteValues);
  const maximum = Math.max(...finiteValues);
  if (minimum === maximum) {
    return values.map((value) => (value === null || !Number.isFinite(value) ? missingValue : 0.5));
  }
  return values.map((value) => {
    if (value === null || !Number.isFinite(value)) {
      return missingValue;
    }
    return (value - minimum) / (maximum - minimum);
  });
}

function assertWeightSet(weightSet: GraphAwareWeightSet): void {
  const sum = FEATURE_ORDER.reduce((total, feature) => total + weightSet.weights[feature], 0);
  if (!Number.isFinite(sum) || Math.abs(sum - 1) > 1e-9) {
    throw new Error(`Graph-aware weights must sum to 1; ${weightSet.name} sums to ${sum}`);
  }
  for (const feature of FEATURE_ORDER) {
    const weight = weightSet.weights[feature];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Graph-aware weight ${feature} must be finite and non-negative`);
    }
  }
}

function rawFeatures(group: SessionRetentionGroup): Record<GraphAwareFeature, number | null> {
  const activityAt = latestTimestamp([
    group.lastActivityAt,
    group.lastInteractionAt,
    group.updatedAt,
  ]);
  const accessAt = latestTimestamp([group.lastReadAt, group.lastInteractionAt]);
  const relationshipCount =
    group.parentGroupIds.length +
    group.childGroupIds.length +
    group.previousGenerationGroupIds.length +
    group.forkSourceGroupIds.length;
  return {
    activityRecency: activityAt,
    accessRecency: accessAt,
    lineageCentrality: finiteNonNegative(relationshipCount),
    directFanout: finiteNonNegative(group.directChildCount + group.forkFanout),
    descendantReach: finiteNonNegative(group.descendantCount),
    generationContinuity: finiteNonNegative(group.generationCount + group.generationLinkCount),
    transcriptEvidence: finiteNonNegative(
      Math.log1p(group.transcriptEventCount) + Math.log1p(group.parentLinkedEventCount),
    ),
  };
}

function estimateRecoveryCost(group: SessionRetentionGroup): number {
  const eventCost = Math.log1p(finiteNonNegative(group.transcriptEventCount));
  const byteCost = Math.log1p(finiteNonNegative(group.reclaimableBytes)) / 8;
  const generationCost = Math.log1p(finiteNonNegative(group.generationCount));
  return roundScore(Math.max(1, 1 + eventCost + byteCost + generationCost));
}

export function scoreGraphAwareGroups(
  groups: readonly SessionRetentionGroup[],
  weightSet: GraphAwareWeightSet = PRIMARY_GRAPH_WEIGHTS,
): Map<string, GraphAwareScore> {
  assertWeightSet(weightSet);
  const eligible = groups.filter((group) => !group.protected);
  const rawByGroup = eligible.map(rawFeatures);
  const normalizedByFeature = new Map<GraphAwareFeature, number[]>();
  for (const feature of FEATURE_ORDER) {
    normalizedByFeature.set(
      feature,
      normalizeFeature(rawByGroup.map((features) => features[feature])),
    );
  }
  const normalizedBytes = normalizeFeature(
    eligible.map((group) => finiteNonNegative(group.reclaimableBytes)),
    0,
  );
  const scores = new Map<string, GraphAwareScore>();
  for (const [index, group] of eligible.entries()) {
    const raw = rawByGroup[index];
    if (!raw) {
      continue;
    }
    const contributions = FEATURE_ORDER.map((feature) => {
      const rawValue = raw[feature] ?? 0;
      const normalizedValue = normalizedByFeature.get(feature)?.[index] ?? 0;
      const weight = weightSet.weights[feature];
      return {
        feature,
        rawValue: roundScore(rawValue),
        normalizedValue: roundScore(normalizedValue),
        weight,
        contribution: roundScore(normalizedValue * weight),
      };
    });
    const recoveryValue = roundScore(
      contributions.reduce((total, contribution) => total + contribution.contribution, 0),
    );
    const estimatedRecoveryCost = estimateRecoveryCost(group);
    const recoveryPriority = roundScore(recoveryValue / estimatedRecoveryCost);
    const evictionPriority = roundScore((normalizedBytes[index] ?? 0) / (0.05 + recoveryValue));
    scores.set(group.groupId, {
      recoveryValue,
      estimatedRecoveryCost,
      evictionPriority,
      recoveryPriority,
      contributions,
    });
  }
  return scores;
}

function compareStableTie(left: SessionRetentionGroup, right: SessionRetentionGroup): number {
  const plannerOrder = left.existingOrder - right.existingOrder;
  if (plannerOrder !== 0) {
    return plannerOrder;
  }
  const leftUpdatedAt = finiteTimestamp(left.updatedAt) ?? Number.NEGATIVE_INFINITY;
  const rightUpdatedAt = finiteTimestamp(right.updatedAt) ?? Number.NEGATIVE_INFINITY;
  if (leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt - rightUpdatedAt;
  }
  return left.groupId.localeCompare(right.groupId);
}

function compareNullableTimestamp(left: number | null, right: number | null): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

export function rankRetentionGroups(params: {
  groups: readonly SessionRetentionGroup[];
  policy: RetentionPolicyName;
}): RankedRetentionGroup[] {
  const weightSet =
    params.policy === "graph-aware-balanced" ? BALANCED_GRAPH_WEIGHTS : PRIMARY_GRAPH_WEIGHTS;
  const scores = scoreGraphAwareGroups(params.groups, weightSet);
  const ranked = params.groups
    .filter((group) => !group.protected)
    .map((group) => {
      const score = scores.get(group.groupId);
      if (!score) {
        throw new Error(`Missing score for eligible retention group ${group.groupId}`);
      }
      return { group, score };
    });
  return ranked.toSorted((left, right) => {
    if (params.policy === "existing-order") {
      return compareStableTie(left.group, right.group);
    }
    if (params.policy === "least-recently-active") {
      const recencyOrder = compareNullableTimestamp(
        resolveLeastRecentActivityAt(left.group),
        resolveLeastRecentActivityAt(right.group),
      );
      return recencyOrder || compareStableTie(left.group, right.group);
    }
    if (params.policy === "size-first") {
      const sizeOrder = right.group.reclaimableBytes - left.group.reclaimableBytes;
      return sizeOrder || compareStableTie(left.group, right.group);
    }
    const priorityOrder = right.score.evictionPriority - left.score.evictionPriority;
    return priorityOrder || compareStableTie(left.group, right.group);
  });
}

export function rankRetentionGroupsForRecovery(params: {
  groups: readonly SessionRetentionGroup[];
  weightSet?: GraphAwareWeightSet;
}): RankedRetentionGroup[] {
  const scores = scoreGraphAwareGroups(params.groups, params.weightSet);
  return params.groups
    .filter((group) => !group.protected)
    .map((group) => {
      const score = scores.get(group.groupId);
      if (!score) {
        throw new Error(`Missing score for eligible retention group ${group.groupId}`);
      }
      return { group, score };
    })
    .toSorted(
      (left, right) =>
        right.score.recoveryPriority - left.score.recoveryPriority ||
        compareStableTie(left.group, right.group),
    );
}

export function selectGroupsToByteTarget(
  ranking: readonly RankedRetentionGroup[],
  targetBytes: number,
): RankedRetentionGroup[] {
  const target = finiteNonNegative(targetBytes);
  if (target === 0) {
    return [];
  }
  const selected: RankedRetentionGroup[] = [];
  let bytes = 0;
  for (const ranked of ranking) {
    selected.push(ranked);
    bytes += finiteNonNegative(ranked.group.reclaimableBytes);
    if (bytes >= target) {
      break;
    }
  }
  return selected;
}
