import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPluginContractTestShards } from "../../scripts/lib/plugin-contract-test-plan.mjs";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";

function listContractTests(rootDir = "src/plugins/contracts"): string[] {
  const files = listGitTrackedFiles({ pathspecs: rootDir });
  expect(files).not.toBeNull();
  return (files ?? []).filter((line) => line.endsWith(".test.ts"));
}

describe("scripts/lib/plugin-contract-test-plan.mjs", () => {
  it("keeps manual CI compatible with legacy target refs", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain(
      'await import(\n            "./scripts/lib/plugin-contract-test-plan.mjs"',
    );
    expect(workflow).toContain("checks-fast-contracts-plugins-legacy");
    expect(workflow).not.toContain(
      "createPluginContractTestShards: () => [\n              createPluginContractTestShards",
    );
  });

  it("splits plugin contracts into focused shards", () => {
    const suffixes = ["a", "b", "c", "d"];

    expect(
      createPluginContractTestShards().map((shard) => ({
        checkName: shard.checkName,
        runtime: shard.runtime,
        task: shard.task,
      })),
    ).toEqual(
      suffixes.map((suffix) => ({
        checkName: `checks-fast-contracts-plugins-${suffix}`,
        runtime: "node",
        task: "contracts-plugins",
      })),
    );
  });

  it("covers every plugin contract test exactly once", () => {
    const actual = createPluginContractTestShards()
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
      const { createPluginContractTestShards } = await import("./scripts/lib/plugin-contract-test-plan.mjs");
      const shards = createPluginContractTestShards();
      return {
        files: shards.reduce((total, shard) => total + shard.includePatterns.length, 0),
        shards: shards.length,
      };
    `);
    expect(payload.shards).toBe(4);
    expect(payload.files).toBeGreaterThan(0);
  });

  it("keeps plugin registration contract files spread across checks", () => {
    for (const shard of createPluginContractTestShards()) {
      const registrationFiles = shard.includePatterns.filter((pattern) =>
        pattern.includes("/plugin-registration."),
      );
      expect(registrationFiles.length).toBeLessThanOrEqual(7);
    }
  });
});
