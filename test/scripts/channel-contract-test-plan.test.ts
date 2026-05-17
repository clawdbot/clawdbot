import { describe, expect, it } from "vitest";
import { createChannelContractTestShards } from "../../scripts/lib/channel-contract-test-plan.mjs";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";

function listContractTests(rootDir = "src/channels/plugins/contracts"): string[] {
  const files = listGitTrackedFiles({ pathspecs: rootDir });
  expect(files).not.toBeNull();
  return (files ?? []).filter((line) => line.endsWith(".test.ts"));
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

  it("uses git-tracked files without walking contract directories", () => {
    const payload = expectNoNodeFsScans<{
      files: number;
      shards: number;
    }>(`
      const { createChannelContractTestShards } = await import("./scripts/lib/channel-contract-test-plan.mjs");
      const shards = createChannelContractTestShards();
      return {
        files: shards.reduce((total, shard) => total + shard.includePatterns.length, 0),
        shards: shards.length,
      };
    `);
    expect(payload.shards).toBe(3);
    expect(payload.files).toBeGreaterThan(0);
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
