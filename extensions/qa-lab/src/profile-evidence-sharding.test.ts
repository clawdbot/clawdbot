import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import {
  aggregateQaProfileEvidenceShards,
  createQaProfileEvidenceShardPlan,
} from "./profile-evidence-sharding.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import type { QaScenarioExecutionCell } from "./scenario-lane.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { exclusiveLiveChannels, liveAdapterFactories } = vi.hoisted(() => {
  const definitions = [
    ["buzz", false, false],
    ["discord", false, true],
    ["matrix", true, true],
    ["msteams", true, false],
    ["slack", false, true],
    ["telegram", false, false],
    ["whatsapp", false, true],
  ] as const;
  return {
    exclusiveLiveChannels: definitions
      .filter(([, isolatesInstances]) => !isolatesInstances)
      .map(([channelId]) => channelId),
    liveAdapterFactories: definitions.map(([channelId, isolatesInstances, supportsModuleFlows]) => {
      const factory: {
        id: string;
        isolatesInstances?: true;
        matches: (context: { channelId: string; driver: string }) => boolean;
        supportsModuleFlows?: true;
      } = {
        id: channelId,
        matches: (context) => context.channelId === channelId && context.driver === "live",
      };
      if (isolatesInstances) {
        factory.isolatesInstances = true;
      }
      if (supportsModuleFlows) {
        factory.supportsModuleFlows = true;
      }
      return factory;
    }),
  };
});

vi.mock("./live-transports/cli.js", () => ({
  listLiveTransportQaAdapterFactories: () => liveAdapterFactories,
}));

type ShardPlan = ReturnType<typeof createQaProfileEvidenceShardPlan>;

function scenarioLiveChannels(
  scenario: ReturnType<typeof readQaScenarioPack>["scenarios"][number],
) {
  if (scenario.execution.channel) {
    return [scenario.execution.channel];
  }
  return scenario.execution.kind === "flow"
    ? (scenario.execution.channels?.filter((channel) => channel !== "qa-channel") ?? [])
    : [];
}

function shardIdForScenario(plan: ShardPlan, scenarioId: string) {
  return plan.shards.find((shard) => shard.scenarioIds.includes(scenarioId))?.id;
}

async function writeShardEvidenceSet(params: {
  incompleteFirstShard?: boolean;
  outputDir: string;
}) {
  const artifactContent = "shard artifact content\n";
  const artifactRelativePath = path.join("playwright", "scenario.log");
  const unreferencedPayloadContent = "unreferenced shard diagnostics\n";
  const unreferencedPayloadRelativePath = path.join("diagnostics", "raw.log");
  const shardPlan = createQaProfileEvidenceShardPlan("all");
  const scenarioById = new Map(
    readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
  );
  const evidencePaths: string[] = [];
  for (const [index, shard] of shardPlan.shards.entries()) {
    const scenarios = shard.scenarioIds.map((scenarioId) => {
      const scenario = scenarioById.get(scenarioId);
      if (!scenario) {
        throw new Error(`missing scenario ${scenarioId}`);
      }
      return scenario;
    });
    const expectedCells: QaScenarioExecutionCell[] = scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      executionKind: scenario.execution.kind,
      channel: null,
    }));
    const observedCells =
      params.incompleteFirstShard && index === 0 ? expectedCells.slice(1) : expectedCells;
    const profilePlan = qaProfileEvidencePlan.build({
      profile: "all",
      membershipScenarios: scenarios,
      selectedScenarios: scenarios,
      excludedScenarios: [],
      expectedCells,
      observedCells,
    });
    const evidencePath = path.join(params.outputDir, shard.id, "qa-evidence.json");
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    const entries =
      index === 0
        ? [
            {
              test: {
                kind: "qa-scenario",
                id: scenarios[0]?.id ?? "shard-scenario",
                title: scenarios[0]?.title ?? "Shard scenario",
              },
              coverage: [],
              execution: {
                runner: "qa-suite",
                environment: { ref: null, os: "linux", nodeVersion: "24.0.0" },
                provider: {
                  id: "mock-openai",
                  live: false,
                  model: { name: "test", ref: "mock-openai/test" },
                },
                packageSource: { kind: "source-checkout" },
                artifacts: [
                  {
                    kind: "log",
                    path: `.artifacts/qa-e2e/profile-all-123-1/${shard.id}/${artifactRelativePath}`,
                    source: "qa-suite",
                  },
                ],
              },
              result: { status: "pass" },
            },
          ]
        : [];
    if (index === 0) {
      await fs.mkdir(path.join(path.dirname(evidencePath), "playwright"), { recursive: true });
      await fs.mkdir(path.join(path.dirname(evidencePath), "diagnostics"), { recursive: true });
      await fs.writeFile(
        path.join(path.dirname(evidencePath), artifactRelativePath),
        artifactContent,
        "utf8",
      );
      await fs.writeFile(
        path.join(path.dirname(evidencePath), unreferencedPayloadRelativePath),
        unreferencedPayloadContent,
        "utf8",
      );
    }
    await fs.writeFile(
      evidencePath,
      `${JSON.stringify({
        kind: QA_EVIDENCE_SUMMARY_KIND,
        schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
        generatedAt: "2026-08-16T00:00:00.000Z",
        evidenceMode: "full",
        entries,
        profile: "all",
        profilePlan,
      })}\n`,
      "utf8",
    );
    evidencePaths.push(evidencePath);
  }
  return {
    artifactContent,
    evidencePaths,
    shardPlan,
    unreferencedPayloadContent,
    unreferencedPayloadRelativePath,
  };
}

describe("QA profile evidence sharding", () => {
  it("partitions the real all profile while keeping exclusive live channels shard-affine", () => {
    const serialPlan = createQaProfileEvidenceShardPlan("all", 1);
    const plan = createQaProfileEvidenceShardPlan("all");
    const scenarioIds = plan.shards.flatMap((shard) => shard.scenarioIds);
    const scenarioById = new Map(
      readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario] as const),
    );

    expect(serialPlan.shards).toHaveLength(1);
    expect(new Set(scenarioIds)).toEqual(new Set(serialPlan.shards[0]?.scenarioIds));
    expect(plan.shards).toHaveLength(8);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect(plan.shards.every((shard) => shard.scenarioIds.length > 0)).toBe(true);
    expect(Math.max(...plan.shards.map((shard) => shard.estimatedCost))).toBeLessThan(
      plan.shards.reduce((total, shard) => total + shard.estimatedCost, 0),
    );

    for (const channelId of exclusiveLiveChannels) {
      const matchingScenarioIds = scenarioIds.filter((scenarioId) => {
        const scenario = scenarioById.get(scenarioId);
        return scenario ? scenarioLiveChannels(scenario).includes(channelId) : false;
      });
      expect(matchingScenarioIds.length, `${channelId} selected scenarios`).toBeGreaterThan(0);
      expect(
        new Set(matchingScenarioIds.map((scenarioId) => shardIdForScenario(plan, scenarioId))).size,
        `${channelId} shard affinity`,
      ).toBe(1);
    }
    expect(shardIdForScenario(plan, "channel-canary")).toBe(
      shardIdForScenario(plan, "thread-follow-up"),
    );
  });

  it("attests a complete aggregate assembled from every planned shard", async () => {
    const outputDir = tempDirs.make("qa-profile-shards-complete-");
    const {
      artifactContent,
      evidencePaths,
      shardPlan,
      unreferencedPayloadContent,
      unreferencedPayloadRelativePath,
    } = await writeShardEvidenceSet({ outputDir });
    const outputPath = path.join(outputDir, "aggregate", "qa-evidence.json");
    const aggregate = await aggregateQaProfileEvidenceShards({
      evidencePaths,
      generatedAt: "2026-08-16T00:00:01.000Z",
      outputPath,
      profile: "all",
    });

    expect(aggregate.profilePlan?.selected).toHaveLength(
      shardPlan.shards.flatMap((shard) => shard.scenarioIds).length,
    );
    expect(aggregate.profilePlan?.missingCells).toEqual([]);
    expect(aggregate.scorecard?.categories.total).toBeGreaterThan(0);
    expect(() => qaProfileEvidencePlan.attest(aggregate.profilePlan, true)).not.toThrow();
    const firstShardId = shardPlan.shards[0]?.id;
    const mergedArtifactPath = aggregate.entries[0]?.execution?.artifacts[0]?.path;
    expect(firstShardId).toBeDefined();
    expect(mergedArtifactPath).toBe(`shards/${firstShardId}/playwright/scenario.log`);
    expect(
      await fs.readFile(path.resolve(path.dirname(outputPath), mergedArtifactPath!), "utf8"),
    ).toBe(artifactContent);
    expect(
      await fs.readFile(
        path.join(
          path.dirname(outputPath),
          "shards",
          firstShardId!,
          unreferencedPayloadRelativePath,
        ),
        "utf8",
      ),
    ).toBe(unreferencedPayloadContent);
  });

  it("preserves an incomplete child as incomplete aggregate evidence", async () => {
    const outputDir = tempDirs.make("qa-profile-shards-incomplete-");
    const { evidencePaths } = await writeShardEvidenceSet({
      incompleteFirstShard: true,
      outputDir,
    });
    const aggregate = await aggregateQaProfileEvidenceShards({
      evidencePaths,
      generatedAt: "2026-08-16T00:00:01.000Z",
      outputPath: path.join(outputDir, "aggregate", "qa-evidence.json"),
      profile: "all",
    });

    expect(aggregate.profilePlan?.missingCells).toHaveLength(1);
    expect(() => qaProfileEvidencePlan.attest(aggregate.profilePlan, true)).toThrow(
      "successful QA profile evidence is missing 1 expected execution cell",
    );
  });

  it("rejects a repo-relative artifact path that cannot be mapped to its shard payload", async () => {
    const outputDir = tempDirs.make("qa-profile-shards-missing-artifact-");
    const { evidencePaths } = await writeShardEvidenceSet({ outputDir });
    const evidencePath = evidencePaths[0];
    if (!evidencePath) {
      throw new Error("expected shard evidence");
    }
    const summary = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(evidencePath, "utf8")),
    );
    const artifact = summary.entries[0]?.execution?.artifacts[0];
    if (!artifact) {
      throw new Error("expected declared shard artifact");
    }
    artifact.path = ".artifacts/nonexistent/qa-evidence.json";
    await fs.writeFile(evidencePath, `${JSON.stringify(summary)}\n`, "utf8");

    await expect(
      aggregateQaProfileEvidenceShards({
        evidencePaths,
        generatedAt: "2026-08-16T00:00:01.000Z",
        outputPath: path.join(outputDir, "aggregate", "qa-evidence.json"),
        profile: "all",
      }),
    ).rejects.toThrow("was not found within downloaded payload");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a declared artifact symlink that would retain its source-payload target",
    async () => {
      const outputDir = tempDirs.make("qa-profile-shards-symlink-artifact-");
      const { evidencePaths } = await writeShardEvidenceSet({ outputDir });
      const evidencePath = evidencePaths[0];
      if (!evidencePath) {
        throw new Error("expected shard evidence");
      }
      const artifactPath = path.join(path.dirname(evidencePath), "playwright", "scenario.log");
      await fs.rm(artifactPath);
      await fs.symlink(
        path.join(path.dirname(evidencePath), "diagnostics", "raw.log"),
        artifactPath,
      );

      await expect(
        aggregateQaProfileEvidenceShards({
          evidencePaths,
          generatedAt: "2026-08-16T00:00:01.000Z",
          outputPath: path.join(outputDir, "aggregate", "qa-evidence.json"),
          profile: "all",
        }),
      ).rejects.toThrow("traverses a symbolic link");
    },
  );

  it("rejects duplicate or missing shards instead of treating them as partial evidence", async () => {
    const outputDir = tempDirs.make("qa-profile-shards-invalid-");
    const { evidencePaths, shardPlan } = await writeShardEvidenceSet({ outputDir });
    const aggregate = (paths: string[]) =>
      aggregateQaProfileEvidenceShards({
        evidencePaths: paths,
        generatedAt: "2026-08-16T00:00:01.000Z",
        outputPath: path.join(outputDir, "aggregate", "qa-evidence.json"),
        profile: "all",
      });

    await expect(aggregate(evidencePaths.slice(1))).rejects.toThrow(
      `requires ${shardPlan.shards.length} shard evidence files`,
    );
    const duplicatePath = evidencePaths[1];
    if (!duplicatePath) {
      throw new Error("expected at least two QA profile shard fixtures");
    }
    await expect(aggregate([...evidencePaths.slice(1), duplicatePath])).rejects.toThrow(
      "does not match one unique planned shard",
    );
  });
});
