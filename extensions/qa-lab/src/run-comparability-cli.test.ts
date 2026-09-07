import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerQaLabCli } from "./cli.js";

describe("qa parity-report --cross-harness", () => {
  let repoRoot: string;
  let priorExitCode: typeof process.exitCode;
  const input = () => ({
    run: {
      status: "completed",
      primaryModel: "provider/model",
      primaryProvider: "provider",
      alternateModel: "alternate/model",
      alternateProvider: "alternate",
      comparisonIdentity: {
        version: 1,
        taskDigest: "1".repeat(64),
        sourceRevision: "2".repeat(40),
        checkProfileDigest: "3".repeat(64),
        runProfileDigest: "4".repeat(64),
        requiredScenarios: ["check"],
        harness: "harness-a",
      },
    },
    scenarios: [{ name: "check", status: "pass" }],
  });
  const run = async (...extra: string[]) => {
    const program = new Command().exitOverride();
    registerQaLabCli(program);
    await program.parseAsync(
      [
        "qa",
        "parity-report",
        "--cross-harness",
        "--repo-root",
        repoRoot,
        "--candidate-summary",
        "candidate.json",
        "--baseline-summary",
        "baseline.json",
        "--output-dir",
        "out",
        ...extra,
      ],
      { from: "user" },
    );
  };

  beforeEach(async () => {
    repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-comparison-cli-")));
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await fs.writeFile(path.join(repoRoot, "candidate.json"), JSON.stringify(input()));
    await fs.writeFile(path.join(repoRoot, "baseline.json"), JSON.stringify(input()));
  });
  afterEach(async () => {
    process.exitCode = priorExitCode;
    vi.restoreAllMocks();
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("runs the real parser and writes check outcomes without treating a regression as a winner decision", async () => {
    const candidate = input();
    candidate.scenarios[0]!.status = "fail";
    await fs.writeFile(path.join(repoRoot, "candidate.json"), JSON.stringify(candidate));
    await run();
    const report = JSON.parse(
      await fs.readFile(path.join(repoRoot, "out/qa-cross-harness-comparison.json"), "utf8"),
    );
    expect(report).toMatchObject({
      status: "comparable",
      regressions: ["check"],
      candidate: {
        primaryModel: "provider/model",
        primaryProvider: "provider",
        alternateModel: "alternate/model",
        alternateProvider: "alternate",
        elapsedMs: null,
      },
    });
    expect(process.exitCode).toBeUndefined();
    expect(report).not.toHaveProperty("winner");
  });

  it("writes not-comparable and exits unsuccessfully for an incomplete run", async () => {
    const candidate = input();
    candidate.run.status = "running";
    await fs.writeFile(path.join(repoRoot, "candidate.json"), JSON.stringify(candidate));
    await run();
    const report = JSON.parse(
      await fs.readFile(path.join(repoRoot, "out/qa-cross-harness-comparison.json"), "utf8"),
    );
    expect(report.status).toBe("not-comparable");
    expect(report.reasons).toEqual(["Candidate lacks valid completed-run comparison metadata."]);
    expect(process.exitCode).toBe(1);
  });

  it.each(["--runtime-axis", "--token-efficiency"])(
    "rejects conflicting %s before writing a report",
    async (flag) => {
      await expect(run(flag)).rejects.toThrow("--cross-harness cannot be combined");
      await expect(fs.access(path.join(repoRoot, "out"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not overwrite an existing comparison artifact", async () => {
    await run();
    const reportPath = path.join(repoRoot, "out/qa-cross-harness-comparison.json");
    const original = await fs.readFile(reportPath, "utf8");
    await expect(run()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(reportPath, "utf8")).toBe(original);
  });

  it("rejects an oversized input before reading its payload", async () => {
    const handle = await fs.open(path.join(repoRoot, "candidate.json"), "r+");
    try {
      await handle.truncate(16 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await expect(run()).rejects.toMatchObject({ code: "too-large" });
    await expect(
      fs.access(path.join(repoRoot, "out/qa-cross-harness-comparison.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
