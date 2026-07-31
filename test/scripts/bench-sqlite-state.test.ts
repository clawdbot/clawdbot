// Bench SQLite State tests cover benchmark CLI argument safety.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseSqliteStateBenchmarkCli } from "../../scripts/lib/sqlite-state-benchmark-cli.js";

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
});
