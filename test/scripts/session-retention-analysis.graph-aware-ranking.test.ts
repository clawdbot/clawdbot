import { describe, expect, it } from "vitest";
import {
  BALANCED_GRAPH_WEIGHTS,
  PRIMARY_GRAPH_WEIGHTS,
  rankRetentionGroups,
  rankRetentionGroupsForRecovery,
  scoreGraphAwareGroups,
  type SessionRetentionGroup,
} from "../../scripts/session-retention-analysis/graph-aware-ranking.js";
import {
  evaluateRetentionPolicy,
  POLICY_INDEPENDENT_EVALUATION_WEIGHTS,
} from "../../scripts/session-retention-analysis/metrics.js";

function group(
  groupId: string,
  overrides: Partial<SessionRetentionGroup> = {},
): SessionRetentionGroup {
  return {
    groupId,
    sessionKeys: [`agent:main:${groupId}`],
    sessionIds: [`${groupId}-session`],
    existingOrder: 0,
    reclaimableBytes: 1_000,
    transcriptEventCount: 4,
    parentLinkedEventCount: 2,
    generationCount: 1,
    generationLinkCount: 0,
    updatedAt: 100,
    lastReadAt: 90,
    lastInteractionAt: 95,
    lastActivityAt: 100,
    parentGroupIds: [],
    childGroupIds: [],
    previousGenerationGroupIds: [],
    forkSourceGroupIds: [],
    directChildCount: 0,
    descendantCount: 0,
    forkFanout: 0,
    protected: false,
    protectionReasons: [],
    evidence: {
      hasAccessMetadata: true,
      hasLineageMetadata: false,
      hasSizeMetadata: true,
    },
    ...overrides,
  };
}

describe("graph-aware session retention ranking", () => {
  it("never ranks planner-protected groups as removable", () => {
    const protectedGroup = group("protected", {
      protected: true,
      protectionReasons: ["canonical-planner:active-work"],
      reclaimableBytes: 1_000_000,
    });
    const eligibleGroup = group("eligible", { existingOrder: 1 });

    for (const policy of [
      "existing-order",
      "least-recently-active",
      "size-first",
      "graph-aware",
      "graph-aware-balanced",
    ] as const) {
      expect(
        rankRetentionGroups({ groups: [protectedGroup, eligibleGroup], policy }).map(
          (ranked) => ranked.group.groupId,
        ),
      ).toEqual(["eligible"]);
    }
  });

  it("selects whole ownership groups even when one group overshoots the byte target", () => {
    const indivisible = group("indivisible", {
      sessionKeys: ["a", "b"],
      sessionIds: ["one", "two", "shared"],
      reclaimableBytes: 10_000,
    });
    const metrics = evaluateRetentionPolicy({
      groups: [indivisible],
      policy: "existing-order",
      targetBytes: 1,
    });

    expect(metrics.ownershipGroupsSelected).toBe(1);
    expect(metrics.sessionsSelected).toBe(3);
    expect(metrics.actualBytesSelected).toBe(10_000);
    expect(metrics.ownershipGroupSplits).toBe(0);
  });

  it("produces byte-for-byte stable output for stable input", () => {
    const groups = [
      group("second", { existingOrder: 1, updatedAt: 20 }),
      group("first", { existingOrder: 0, updatedAt: 10 }),
    ];
    const serialize = () => JSON.stringify(rankRetentionGroups({ groups, policy: "graph-aware" }));

    expect(serialize()).toBe(serialize());
  });

  it("handles missing access timestamps without invalid scores", () => {
    const missing = group("missing", {
      updatedAt: null,
      lastReadAt: null,
      lastInteractionAt: null,
      lastActivityAt: null,
      evidence: {
        hasAccessMetadata: false,
        hasLineageMetadata: false,
        hasSizeMetadata: true,
      },
    });
    const score = scoreGraphAwareGroups([missing]).get("missing");

    expect(score).toBeDefined();
    expect(
      [
        score?.recoveryValue,
        score?.estimatedRecoveryCost,
        score?.evictionPriority,
        score?.recoveryPriority,
        ...(score?.contributions.flatMap((item) => [
          item.rawValue,
          item.normalizedValue,
          item.contribution,
        ]) ?? []),
      ].every((value) => typeof value === "number" && Number.isFinite(value)),
    ).toBe(true);
  });

  it("breaks exact ties by planner order, update time, then group id", () => {
    const tied = [
      group("z", { existingOrder: 1, updatedAt: 20 }),
      group("b", { existingOrder: 0, updatedAt: 20 }),
      group("a", { existingOrder: 0, updatedAt: 20 }),
      group("c", { existingOrder: 0, updatedAt: 10 }),
    ];

    expect(
      rankRetentionGroups({ groups: tied, policy: "size-first" }).map(
        (ranked) => ranked.group.groupId,
      ),
    ).toEqual(["c", "a", "b", "z"]);
  });

  it("explains fork fan-out differently from an otherwise identical isolated group", () => {
    const connected = group("connected", {
      childGroupIds: ["child-a", "child-b"],
      directChildCount: 2,
      descendantCount: 2,
      forkFanout: 2,
      evidence: {
        hasAccessMetadata: true,
        hasLineageMetadata: true,
        hasSizeMetadata: true,
      },
    });
    const isolated = group("isolated", { existingOrder: 1 });
    const scores = scoreGraphAwareGroups([connected, isolated]);
    const contribution = (groupId: string, feature: string) =>
      scores.get(groupId)?.contributions.find((item) => item.feature === feature)?.contribution ??
      0;

    expect(contribution("connected", "directFanout")).toBeGreaterThan(
      contribution("isolated", "directFanout"),
    );
    expect(scores.get("connected")?.recoveryValue).toBeGreaterThan(
      scores.get("isolated")?.recoveryValue ?? 0,
    );
  });

  it("evicts a large stale isolated group before a smaller relationship-heavy group", () => {
    const largeIsolated = group("large-isolated", {
      reclaimableBytes: 50_000,
      updatedAt: 1,
      lastActivityAt: 1,
      lastInteractionAt: 1,
      lastReadAt: 1,
    });
    const smallConnected = group("small-connected", {
      existingOrder: 1,
      reclaimableBytes: 1_000,
      childGroupIds: ["c1", "c2", "c3"],
      directChildCount: 3,
      descendantCount: 8,
      forkFanout: 3,
      generationCount: 4,
      generationLinkCount: 3,
    });

    expect(
      rankRetentionGroups({
        groups: [smallConnected, largeIsolated],
        policy: "graph-aware",
      })[0]?.group.groupId,
    ).toBe("large-isolated");
  });

  it("uses the same explained score for eviction and inverse recovery operation", () => {
    const groups = [
      group("connected", { directChildCount: 3, descendantCount: 5, forkFanout: 2 }),
      group("isolated", { existingOrder: 1 }),
    ];
    const scores = scoreGraphAwareGroups(groups);
    const recovery = rankRetentionGroupsForRecovery({ groups });

    for (const ranked of recovery) {
      expect(ranked.score).toEqual(scores.get(ranked.group.groupId));
    }
    expect(recovery.map((ranked) => ranked.score.recoveryPriority)).toEqual(
      recovery
        .map((ranked) => ranked.score.recoveryPriority)
        .toSorted((left, right) => right - left),
    );
  });

  it("evaluates every policy with weights that are held out from graph-aware ranking", () => {
    const groups = [
      group("selected-first", {
        existingOrder: 0,
        updatedAt: 1,
        lastActivityAt: 1,
        lastInteractionAt: 1,
        lastReadAt: 1,
      }),
      group("selected-second", {
        existingOrder: 1,
        childGroupIds: ["preserved"],
        directChildCount: 1,
        descendantCount: 1,
        forkFanout: 1,
      }),
      group("preserved", {
        existingOrder: 2,
        updatedAt: 1_000,
        lastActivityAt: 1_000,
        lastInteractionAt: 1_000,
        lastReadAt: 1_000,
        transcriptEventCount: 100,
        parentLinkedEventCount: 50,
      }),
    ];
    const evaluationScores = scoreGraphAwareGroups(groups, POLICY_INDEPENDENT_EVALUATION_WEIGHTS);

    for (const policy of [
      "existing-order",
      "least-recently-active",
      "size-first",
      "graph-aware",
      "graph-aware-balanced",
    ] as const) {
      const metrics = evaluateRetentionPolicy({ groups, policy, targetBytes: 1_500 });
      const selectedIds = new Set(metrics.selectedGroupIds);
      const expected = Number(
        groups
          .filter((item) => !selectedIds.has(item.groupId))
          .reduce(
            (total, item) => total + (evaluationScores.get(item.groupId)?.recoveryValue ?? 0),
            0,
          )
          .toFixed(9),
      );

      expect(metrics.policyIndependentValuePreserved).toBe(expected);
    }

    const graphAwareMetrics = evaluateRetentionPolicy({
      groups,
      policy: "graph-aware",
      targetBytes: 1_500,
    });
    const primaryScores = scoreGraphAwareGroups(groups, PRIMARY_GRAPH_WEIGHTS);
    const graphAwareSelectedIds = new Set(graphAwareMetrics.selectedGroupIds);
    const primaryValuePreserved = Number(
      groups
        .filter((item) => !graphAwareSelectedIds.has(item.groupId))
        .reduce((total, item) => total + (primaryScores.get(item.groupId)?.recoveryValue ?? 0), 0)
        .toFixed(9),
    );
    expect(graphAwareMetrics.selectedGroupIds).toHaveLength(2);
    expect(graphAwareMetrics.policyIndependentValuePreserved).not.toBe(primaryValuePreserved);
    expect(POLICY_INDEPENDENT_EVALUATION_WEIGHTS.weights).not.toEqual(
      PRIMARY_GRAPH_WEIGHTS.weights,
    );
    expect(POLICY_INDEPENDENT_EVALUATION_WEIGHTS.weights).not.toEqual(
      BALANCED_GRAPH_WEIGHTS.weights,
    );
  });

  it("handles ten thousand deterministic in-memory groups without recursive traversal", () => {
    const groups = Array.from({ length: 10_000 }, (_, index) =>
      group(`group-${String(index).padStart(5, "0")}`, {
        existingOrder: index,
        updatedAt: index,
        reclaimableBytes: 100 + (index % 100),
      }),
    );

    const ranked = rankRetentionGroups({ groups, policy: "graph-aware" });
    expect(ranked).toHaveLength(10_000);
    expect(ranked.every((item) => Number.isFinite(item.score.evictionPriority))).toBe(true);
  });
});
