import { describe, expect, it } from "vitest";
import { readMatrixQaScenarioShard, resolveMatrixQaScenarioIds } from "./scenario-selection.js";

const matrixLane = {
  primaryModel: "mock-openai/gpt-5.6-luna",
  providerMode: "mock-openai" as const,
};

describe("Matrix QA scenario selection", () => {
  it("derives the implicit Matrix suite from catalog lane eligibility", () => {
    const scenarioIds = resolveMatrixQaScenarioIds(matrixLane);

    expect(scenarioIds).toContain("channel-chat-baseline");
    expect(scenarioIds).toContain("matrix-room-block-streaming");
    expect(scenarioIds).toContain("subagent-thread-spawn");
    expect(scenarioIds).not.toContain("telegram-commands-command");
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
  });

  it("uses explicit scenarios as the only subset override", () => {
    expect(
      resolveMatrixQaScenarioIds({
        ...matrixLane,
        scenarioIds: ["matrix-room-block-streaming", "channel-chat-baseline"],
      }),
    ).toEqual(["matrix-room-block-streaming", "channel-chat-baseline"]);
  });

  it("enforces Matrix channel eligibility for explicit scenarios", () => {
    expect(() =>
      resolveMatrixQaScenarioIds({
        ...matrixLane,
        scenarioIds: ["telegram-commands-command"],
      }),
    ).toThrow("channel=telegram");
  });

  it("keeps catalog membership identical across live implementations", () => {
    expect(resolveMatrixQaScenarioIds({ ...matrixLane, channelDriver: "live" })).toEqual(
      resolveMatrixQaScenarioIds({ ...matrixLane, channelDriver: "crabline" }),
    );
  });

  it("shards only after semantic selection", () => {
    const all = resolveMatrixQaScenarioIds(matrixLane);
    const shards = Array.from({ length: 5 }, (_, index) =>
      resolveMatrixQaScenarioIds({ ...matrixLane, shard: { count: 5, index: index + 1 } }),
    );
    const sizes = shards.map((shard) => shard.length);

    expect(new Set(shards.flat())).toEqual(new Set(all));
    expect(shards.flat()).toHaveLength(all.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("reads paired internal CI shard settings", () => {
    expect(
      readMatrixQaScenarioShard({
        OPENCLAW_QA_MATRIX_SHARD_COUNT: "5",
        OPENCLAW_QA_MATRIX_SHARD_INDEX: "3",
      }),
    ).toEqual({ count: 5, index: 3 });
    expect(() => readMatrixQaScenarioShard({ OPENCLAW_QA_MATRIX_SHARD_COUNT: "5" })).toThrow(
      "must be set together",
    );
  });
});
