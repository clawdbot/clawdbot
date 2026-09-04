import { describe, expect, it } from "vitest";
import { assignWeightedTestFiles } from "../../scripts/lib/weighted-test-shards.mts";

describe("assignWeightedTestFiles", () => {
  it("balances deterministic ties across repeated assignment batches", () => {
    const shards = [
      { checkName: "check-b", includePatterns: new Array<string>(), weight: 0 },
      { checkName: "check-a", includePatterns: new Array<string>(), weight: 0 },
    ];
    const weights = new Map([
      ["a-heavy.test.ts", 5],
      ["b-heavy.test.ts", 5],
      ["z-light.test.ts", 1],
      ["c-medium.test.ts", 4],
      ["d-medium.test.ts", 4],
    ]);
    const resolveWeight = (file: string) => weights.get(file) ?? 0;

    assignWeightedTestFiles(
      shards,
      ["z-light.test.ts", "b-heavy.test.ts", "a-heavy.test.ts"],
      resolveWeight,
    );
    assignWeightedTestFiles(shards, ["d-medium.test.ts", "c-medium.test.ts"], resolveWeight);

    expect(shards).toEqual([
      {
        checkName: "check-b",
        includePatterns: ["b-heavy.test.ts", "c-medium.test.ts"],
        weight: 9,
      },
      {
        checkName: "check-a",
        includePatterns: ["a-heavy.test.ts", "z-light.test.ts", "d-medium.test.ts"],
        weight: 10,
      },
    ]);
  });

  it("rejects an empty shard list", () => {
    expect(() => assignWeightedTestFiles([], ["contract.test.ts"], () => 1)).toThrow(
      "weighted test shards must not be empty",
    );
  });
});
