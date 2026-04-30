import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginContractTestShards } from "../../scripts/lib/plugin-contract-test-plan.mjs";

function listContractTests(rootDir = "src/plugins/contracts"): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(path.replaceAll("\\", "/"));
      }
    }
  };

  visit(rootDir);
  return files.toSorted((a, b) => a.localeCompare(b));
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

  it("keeps plugin registration contract files spread across checks", () => {
    for (const shard of createPluginContractTestShards()) {
      const registrationFiles = shard.includePatterns.filter((pattern) =>
        pattern.includes("/plugin-registration."),
      );
      expect(registrationFiles.length).toBeLessThanOrEqual(7);
    }
  });
});
