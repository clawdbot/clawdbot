import { describe, expect, it } from "vitest";
import {
  resolveQaExecutionShard,
  selectQaExecutionShardScenarioIds,
} from "./execution-sharding.js";

describe("QA execution sharding", () => {
  it("resolves only valid internal coordinates", () => {
    expect(resolveQaExecutionShard(undefined)).toBeUndefined();
    expect(resolveQaExecutionShard(" 2/5 ")).toEqual({
      index: 2,
      count: 5,
    });
    expect(() => resolveQaExecutionShard("1", "QA execution")).toThrow(
      "QA execution shard must use <index>/<count>",
    );
    expect(() => resolveQaExecutionShard("0/5")).toThrow("1 <= index <= count");
    expect(() => resolveQaExecutionShard("6/5")).toThrow("1 <= index <= count");
  });

  it("partitions a resolved semantic selection deterministically and evenly", () => {
    const semanticScenarioIds = ["four", "one", "five", "two", "three", "six"];
    const shards = [1, 2, 3].map((index) =>
      selectQaExecutionShardScenarioIds(semanticScenarioIds, { index, count: 3 }),
    );

    expect(shards.flat().toSorted()).toEqual(semanticScenarioIds.toSorted());
    expect(new Set(shards.flat()).size).toBe(semanticScenarioIds.length);
    expect(Math.max(...shards.map((shard) => shard.length))).toBe(
      Math.min(...shards.map((shard) => shard.length)),
    );
    expect(
      selectQaExecutionShardScenarioIds(semanticScenarioIds.toReversed(), {
        index: 1,
        count: 3,
      }),
    ).toEqual(shards[0]);
  });

  it("fails when an execution worker receives no resolved scenarios", () => {
    expect(() =>
      selectQaExecutionShardScenarioIds(["only-scenario"], { index: 2, count: 2 }),
    ).toThrow("resolved no scenarios from 1 semantically selected scenario");
  });
});
