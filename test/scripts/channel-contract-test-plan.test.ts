import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannelContractTestShards } from "../../scripts/lib/channel-contract-test-plan.mjs";

function listContractTests(rootDir = "src/channels/plugins/contracts"): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(rootDir, entry.name).replaceAll("\\", "/"))
    .toSorted((a, b) => a.localeCompare(b));
}

describe("scripts/lib/channel-contract-test-plan.mjs", () => {
  it("splits channel contracts into focused shards", () => {
    const suffixes = ["a", "b", "c"];

    expect(
      createChannelContractTestShards().map((shard) => ({
        checkName: shard.checkName,
        runtime: shard.runtime,
        task: shard.task,
      })),
    ).toEqual(
      suffixes.map((suffix) => ({
        checkName: `checks-fast-contracts-channels-${suffix}`,
        runtime: "node",
        task: "contracts-channels",
      })),
    );
  });

  it("covers every channel contract test exactly once", () => {
    const actual = createChannelContractTestShards()
      .flatMap((shard) => shard.includePatterns)
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(listContractTests());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps registry-backed surface shards spread across checks", () => {
    for (const shard of createChannelContractTestShards()) {
      const surfaceRegistryFiles = shard.includePatterns.filter((pattern) =>
        pattern.includes("/surfaces-only.registry-backed-shard-"),
      );
      expect(surfaceRegistryFiles.length).toBeLessThanOrEqual(4);
    }
  });
});
