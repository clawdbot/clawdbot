import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPluginContractTestShards } from "../../scripts/lib/plugin-contract-test-plan.mjs";

function listContractTests(rootDir = "src/plugins/contracts"): string[] {
  const result = spawnSync("git", ["ls-files", "--", rootDir], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  expect(result.status).toBe(0);
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line.endsWith(".test.ts"))
    .toSorted((a, b) => a.localeCompare(b));
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
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const counts = { existsSync: 0, readdirSync: 0 };
          const originalExistsSync = fs.existsSync;
          const originalReaddirSync = fs.readdirSync;
          fs.existsSync = (...args) => {
            counts.existsSync += 1;
            return originalExistsSync(...args);
          };
          fs.readdirSync = (...args) => {
            counts.readdirSync += 1;
            return originalReaddirSync(...args);
          };
          syncBuiltinESMExports();
          const { createPluginContractTestShards } = await import("./scripts/lib/plugin-contract-test-plan.mjs");
          const shards = createPluginContractTestShards();
          console.log(JSON.stringify({
            counts,
            files: shards.reduce((total, shard) => total + shard.includePatterns.length, 0),
            shards: shards.length,
          }));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      counts: { existsSync: number; readdirSync: number };
      files: number;
      shards: number;
    };
    expect(payload.shards).toBe(4);
    expect(payload.files).toBeGreaterThan(0);
    expect(payload.counts).toEqual({ existsSync: 0, readdirSync: 0 });
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
