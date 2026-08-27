// Bench SQLite State tests cover benchmark CLI argument safety.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSqliteStateBenchmarkCli } from "../../scripts/lib/sqlite-state-benchmark-cli.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../src/state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";

function runBench(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/bench-sqlite-state.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
}

describe("scripts/bench-sqlite-state", () => {
  it("rejects unknown args before seeding benchmark databases", () => {
    const result = runBench(["--wat"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: Unknown argument: --wat");
  });

  it("rejects missing output values before seeding benchmark databases", () => {
    expect(() => parseSqliteStateBenchmarkCli(["--output", "--profile", "smoke"])).toThrow(
      "--output requires a value",
    );
  });

  it("rejects short flag output values before seeding benchmark databases", () => {
    expect(() => parseSqliteStateBenchmarkCli(["--output", "-h"])).toThrow(
      "--output requires a value",
    );
  });

  it("rejects invalid profiles without printing a stack trace", () => {
    expect(() => parseSqliteStateBenchmarkCli(["--profile", "huge"])).toThrow(
      '--profile must be one of smoke, default, large; got "huge"',
    );
  });

  it("rejects duplicate single-value controls before seeding benchmark databases", () => {
    expect(() =>
      parseSqliteStateBenchmarkCli(["--profile", "smoke", "--profile", "large"]),
    ).toThrow("--profile was provided more than once");
    expect(parseSqliteStateBenchmarkCli(["--help", "--profile", "huge"])).toEqual({
      help: true,
    });
  });

  it("reports production-shaped SQLite scenarios in the existing smoke benchmark", () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), "openclaw-sqlite-bench-test-"));
    const outputPath = path.join(outputDir, "report.json");
    try {
      const result = runBench(["--profile", "smoke", "--output", outputPath]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("SQLITE_PERF_TRANSCRIPT_ROWS=128");
      const proofLines = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("SQLITE_PERF_SCENARIO "));
      expect(proofLines).toHaveLength(10);

      const report = JSON.parse(readFileSync(outputPath, "utf8")) as {
        schemaVersion: number;
        queries: Array<{
          database: string;
          id: string;
          p50Ms: number;
          p95Ms: number;
          plan: {
            fullTableScans: string[];
            indexes: string[];
            raw: string[];
            tempSorts: string[];
          };
          rows: number;
          runs: number;
          sql: string;
        }>;
        versions: { agentSchema: number; sqlite: string; stateSchema: number };
      };
      expect(report.schemaVersion).toBe(2);
      expect(report.versions).toEqual({
        agentSchema: OPENCLAW_AGENT_SCHEMA_VERSION,
        sqlite: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        stateSchema: OPENCLAW_STATE_SCHEMA_VERSION,
      });

      const expectedIds = [
        "cron.store.load",
        "task-runs.cron.list",
        "task-runs.cron-source.list",
        "delivery.pending.load",
        "ingress.pending.first-page",
        "ingress.pending.seek-page",
        "plugin-state.namespace.live",
        "agent-cache.plugin-model-catalog.list",
        "transcript.tail.metadata",
        "transcript.tail.payload",
      ];
      expect(report.queries.map((query) => query.id)).toEqual(expectedIds);
      expect(new Set(report.queries.map((query) => query.id)).size).toBe(expectedIds.length);
      for (const query of report.queries) {
        expect(["agent", "state"]).toContain(query.database);
        expect(query.rows).toBeGreaterThan(0);
        expect(query.runs).toBeGreaterThan(0);
        expect(Number.isFinite(query.p50Ms)).toBe(true);
        expect(Number.isFinite(query.p95Ms)).toBe(true);
        expect(query.sql).toContain("SELECT");
        expect(query.plan.raw.length).toBeGreaterThan(0);
        expect(query.plan.fullTableScans).toEqual([]);
        if (!query.id.startsWith("task-runs.")) {
          expect(query.plan.tempSorts).toEqual([]);
        }
      }
      for (const id of [
        "task-runs.cron.list",
        "task-runs.cron-source.list",
        "delivery.pending.load",
        "plugin-state.namespace.live",
      ]) {
        expect(report.queries.find((query) => query.id === id)?.runs).toBeLessThanOrEqual(12);
      }
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  });
});
