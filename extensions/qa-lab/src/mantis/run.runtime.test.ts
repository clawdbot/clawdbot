// Qa Lab tests cover run plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QA_EVIDENCE_FILENAME, buildQaSuiteEvidenceSummary } from "../evidence-summary.js";
import { runMantisBeforeAfter } from "./run.runtime.js";

function requireArgAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    throw new Error(`expected ${flag} argument`);
  }
  return expectDefined(args[index + 1], `${flag} argument value`);
}

type StubCommandResult = {
  code: number | null;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  stdoutTruncatedBytes?: number;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
};

function successfulCommandResult(stdout = ""): StubCommandResult {
  return { code: 0, killed: false, signal: null, stderr: "", stdout, termination: "exit" };
}

function failedCommandResult(code = 1): StubCommandResult {
  return { code, killed: false, signal: null, stderr: "", stdout: "", termination: "exit" };
}

function worktreeListOutput(worktreeDir: string): string {
  return `worktree ${worktreeDir}\0HEAD 0000000000000000000000000000000000000000\0detached\0\0`;
}

function timedOutCommandResult(): StubCommandResult {
  return {
    code: 124,
    killed: true,
    signal: "SIGTERM",
    stderr: "",
    stdout: "",
    termination: "timeout",
  };
}

async function writeLegacyLaneSummary(params: { args: readonly string[]; scenario: string }) {
  const repoRootArg = requireArgAfter(params.args, "--repo-root");
  const outputDirArg = requireArgAfter(params.args, "--output-dir");
  const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
  const outputDir = path.join(repoRootArg, outputDirArg);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, "discord-qa-summary.json"),
    `${JSON.stringify(
      { scenarios: [{ id: params.scenario, status: lane === "baseline" ? "fail" : "pass" }] },
      null,
      2,
    )}\n`,
  );
}

describe("mantis before/after runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("runs baseline and candidate worktrees and writes stable comparison artifacts", async () => {
    const commands: { args: readonly string[]; command: string; stage: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      commands.push({ command, args, stage: execution.stage });
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        await fs.rm(String(args[4]), { force: true, recursive: true });
        return successfulCommandResult();
      }
      if (command !== "pnpm" || !args.includes("openclaw")) {
        return successfulCommandResult();
      }
      const repoRootArg = requireArgAfter(args, "--repo-root");
      const outputDirArg = requireArgAfter(args, "--output-dir");
      const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
      const outputDir = path.join(repoRootArg, outputDirArg);
      await fs.mkdir(outputDir, { recursive: true });
      const screenshotPath = path.join(outputDir, `${lane}-timeline.png`);
      const videoPath = path.join(outputDir, `${lane}-timeline.mp4`);
      await fs.writeFile(screenshotPath, `${lane} screenshot`);
      await fs.writeFile(videoPath, `${lane} video`);
      const title = "Discord explicit status reactions run in tool-only reply mode";
      const summary = buildQaSuiteEvidenceSummary({
        artifactPaths: [
          { kind: "summary", path: QA_EVIDENCE_FILENAME },
          { kind: "report", path: "discord-qa-report.md" },
          { kind: "screenshot", path: screenshotPath },
          { kind: "video", path: videoPath },
        ],
        channelDriver: "live",
        channelId: "discord",
        scenarioDefinitions: [
          {
            id: "discord-status-reactions-tool-only",
            title,
          },
        ],
        generatedAt: "2026-05-03T12:00:00.000Z",
        primaryModel: "openai/gpt-5.4",
        providerMode: "live-frontier",
        scenarioResults: [
          {
            details:
              lane === "baseline"
                ? "reaction timeline missing thinking/done"
                : "reaction timeline matched queued -> thinking -> done",
            name: title,
            status: lane === "baseline" ? "fail" : "pass",
          },
        ],
      });
      await fs.writeFile(
        path.join(outputDir, QA_EVIDENCE_FILENAME),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      return successfulCommandResult();
    });

    const result = await runMantisBeforeAfter({
      baseline: "--lock",
      candidate: "--force",
      commandRunner: runner,
      now: () => new Date("2026-05-03T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/test-run",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    });

    expect(result.status).toBe("pass");
    expect(commands).toHaveLength(6);
    expect(commands.map((entry) => entry.stage)).toEqual([
      "worktree-add",
      "qa",
      "worktree-cleanup",
      "worktree-add",
      "qa",
      "worktree-cleanup",
    ]);
    expect(commands[0]?.command).toBe("git");
    expect(commands[0]?.args).toEqual([
      "worktree",
      "add",
      "--detach",
      "--",
      path.join(result.outputDir, "worktrees", "baseline"),
      "--lock",
    ]);
    expect(commands[1]?.command).toBe("pnpm");
    expect(commands[1]?.args[0]).toBe("--dir");
    expect(commands[1]?.args[1]).toBe(path.join(result.outputDir, "worktrees", "baseline"));
    expect(commands[1]?.args.slice(2, 4)).toEqual(["openclaw", "qa"]);
    expect(commands[2]?.command).toBe("git");
    expect(commands[2]?.args).toEqual([
      "worktree",
      "remove",
      "--force",
      "--",
      path.join(result.outputDir, "worktrees", "baseline"),
    ]);
    expect(commands[3]?.command).toBe("git");
    expect(commands[3]?.args).toEqual([
      "worktree",
      "add",
      "--detach",
      "--",
      path.join(result.outputDir, "worktrees", "candidate"),
      "--force",
    ]);
    expect(commands[4]?.command).toBe("pnpm");
    expect(commands[4]?.args[0]).toBe("--dir");
    expect(commands[4]?.args[1]).toBe(path.join(result.outputDir, "worktrees", "candidate"));
    expect(commands[4]?.args.slice(2, 4)).toEqual(["openclaw", "qa"]);
    expect(commands[5]?.command).toBe("git");
    expect(commands[5]?.args).toEqual([
      "worktree",
      "remove",
      "--force",
      "--",
      path.join(result.outputDir, "worktrees", "candidate"),
    ]);

    const comparison = JSON.parse(await fs.readFile(result.comparisonPath, "utf8")) as {
      baseline: { reproduced: boolean; status: string };
      candidate: { fixed: boolean; status: string };
      pass: boolean;
    };
    expect(comparison.baseline.reproduced).toBe(true);
    expect(comparison.baseline.status).toBe("fail");
    expect(comparison.candidate.fixed).toBe(true);
    expect(comparison.candidate.status).toBe("pass");
    expect(comparison.pass).toBe(true);
    await expect(
      fs.readFile(path.join(result.outputDir, "baseline", "baseline.png"), "utf8"),
    ).resolves.toBe("baseline screenshot");
    await expect(
      fs.readFile(path.join(result.outputDir, "candidate", "candidate.png"), "utf8"),
    ).resolves.toBe("candidate screenshot");
    await expect(
      fs.readFile(path.join(result.outputDir, "baseline", "baseline.mp4"), "utf8"),
    ).resolves.toBe("baseline video");
    await expect(
      fs.readFile(path.join(result.outputDir, "candidate", "candidate.mp4"), "utf8"),
    ).resolves.toBe("candidate video");
    await expect(
      fs.stat(path.join(result.outputDir, "worktrees", "baseline")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(result.outputDir, "worktrees", "candidate")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports the Discord thread filePath attachment Mantis scenario", async () => {
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command !== "pnpm" || !args.includes("openclaw")) {
        return successfulCommandResult();
      }
      const repoRootArg = requireArgAfter(args, "--repo-root");
      const outputDirArg = requireArgAfter(args, "--output-dir");
      const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
      const outputDir = path.join(repoRootArg, outputDirArg);
      await fs.mkdir(outputDir, { recursive: true });
      const screenshotPath = path.join(outputDir, `${lane}-thread-attachment.png`);
      await fs.writeFile(screenshotPath, `${lane} attachment screenshot`);
      await fs.writeFile(
        path.join(outputDir, "discord-qa-summary.json"),
        `${JSON.stringify(
          {
            scenarios: [
              {
                artifactPaths: { screenshot: screenshotPath },
                details:
                  lane === "baseline"
                    ? "thread reply omitted mantis-thread-report.md"
                    : "thread reply attached mantis-thread-report.md",
                id: "discord-thread-reply-filepath-attachment",
                status: lane === "baseline" ? "fail" : "pass",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
      return successfulCommandResult();
    });

    const result = await runMantisBeforeAfter({
      baseline: "bug-sha",
      candidate: "fix-sha",
      commandRunner: runner,
      now: () => new Date("2026-05-03T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/thread-run",
      repoRoot,
      scenario: "discord-thread-reply-filepath-attachment",
      skipBuild: true,
      skipInstall: true,
    });

    expect(result.status).toBe("pass");
    const comparison = JSON.parse(await fs.readFile(result.comparisonPath, "utf8")) as {
      baseline: { expected: string; reproduced: boolean };
      candidate: { expected: string; fixed: boolean };
      pass: boolean;
    };
    expect(comparison.baseline.expected).toBe("thread reply omits filePath attachment");
    expect(comparison.baseline.reproduced).toBe(true);
    expect(comparison.candidate.expected).toBe("thread reply includes filePath attachment");
    expect(comparison.candidate.fixed).toBe(true);
    expect(comparison.pass).toBe(true);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8")) as {
      artifacts: { alt?: string; label: string }[];
      title: string;
    };
    expect(manifest.title).toBe("Mantis Discord Thread Attachment QA");
    const baselineArtifact = manifest.artifacts.find(
      (artifact) => artifact.label === "Baseline missing filePath attachment",
    );
    expect(baselineArtifact?.alt).toBe("Baseline Discord thread reply without filePath attachment");
    const candidateArtifact = manifest.artifacts.find(
      (artifact) => artifact.label === "Candidate includes filePath attachment",
    );
    expect(candidateArtifact?.alt).toBe("Candidate Discord thread reply with filePath attachment");
  });

  it.each([
    {
      qaTimeoutMs: 450_000,
      scenario: "discord-status-reactions-tool-only",
    },
    {
      qaTimeoutMs: 390_000,
      scenario: "discord-thread-reply-filepath-attachment",
    },
  ])("runs %s commands with stage-owned total deadlines", async ({ qaTimeoutMs, scenario }) => {
    const executions: { stage: string; timeoutMs: number }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      executions.push({ stage: execution.stage, timeoutMs: execution.timeoutMs });
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        await fs.rm(String(args[4]), { force: true, recursive: true });
      }
      if (command === "pnpm" && args.includes("openclaw")) {
        await writeLegacyLaneSummary({ args, scenario });
      }
      return successfulCommandResult();
    });

    const result = await runMantisBeforeAfter({
      baseline: "bug-sha",
      candidate: "fix-sha",
      commandRunner: runner,
      now: () => new Date("2026-05-03T12:00:00.000Z"),
      outputDir: `.artifacts/qa-e2e/mantis/${scenario}-deadlines`,
      repoRoot,
      scenario,
    });

    expect(result.status).toBe("pass");
    await expect(
      fs.stat(path.join(result.outputDir, "worktrees", "baseline")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(result.outputDir, "worktrees", "candidate")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(executions).toEqual([
      { stage: "worktree-add", timeoutMs: 300_000 },
      { stage: "install", timeoutMs: 1_800_000 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: qaTimeoutMs },
      { stage: "worktree-cleanup", timeoutMs: 120_000 },
      { stage: "worktree-add", timeoutMs: 300_000 },
      { stage: "install", timeoutMs: 1_800_000 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: qaTimeoutMs },
      { stage: "worktree-cleanup", timeoutMs: 120_000 },
    ]);
  });

  it("normalizes command timeout overrides per stage", async () => {
    const executions: { stage: string; timeoutMs: number }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      executions.push({ stage: execution.stage, timeoutMs: execution.timeoutMs });
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        await fs.rm(String(args[4]), { force: true, recursive: true });
      }
      if (command === "pnpm" && args.includes("openclaw")) {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
      }
      return successfulCommandResult();
    });

    await runMantisBeforeAfter({
      baseline: "bug-sha",
      candidate: "fix-sha",
      commandRunner: runner,
      commandTimeouts: {
        "worktree-add": 111,
        install: 222,
        build: 0,
        qa: 444,
        "worktree-cleanup": -1,
      },
      now: () => new Date("2026-05-03T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/override-deadlines",
      repoRoot,
    });

    expect(executions.slice(0, 5)).toEqual([
      { stage: "worktree-add", timeoutMs: 111 },
      { stage: "install", timeoutMs: 222 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: 444 },
      { stage: "worktree-cleanup", timeoutMs: 120_000 },
    ]);
  });

  it("does not dispatch a lane command when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn(async () => successfulCommandResult());

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/pre-aborted",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow("baseline worktree-add aborted");
    expect(runner).not.toHaveBeenCalled();
  });

  it("cleans up the exact worktree path after worktree-add times out", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "add-timeout");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const calls: {
      args: readonly string[];
      command: string;
      signal?: AbortSignal;
      stage: string;
      timeoutMs: number;
    }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      calls.push({
        args,
        command,
        signal: execution.signal,
        stage: execution.stage,
        timeoutMs: execution.timeoutMs,
      });
      if (execution.stage === "worktree-add") {
        return timedOutCommandResult();
      }
      return successfulCommandResult();
    });

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        commandTimeouts: { "worktree-add": 123, "worktree-cleanup": 456 },
        outputDir: ".artifacts/qa-e2e/mantis/add-timeout",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow("baseline worktree-add timed out after 123ms");

    expect(calls).toEqual([
      {
        args: ["worktree", "add", "--detach", "--", baselineWorktreeDir, "baseline-ref"],
        command: "git",
        signal: undefined,
        stage: "worktree-add",
        timeoutMs: 123,
      },
      {
        args: ["worktree", "remove", "--force", "--", baselineWorktreeDir],
        command: "git",
        signal: undefined,
        stage: "worktree-cleanup",
        timeoutMs: 456,
      },
    ]);
  });

  it("refuses to reuse an existing worktree directory", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "existing-worktree");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const sentinelPath = path.join(baselineWorktreeDir, "keep.txt");
    await fs.mkdir(baselineWorktreeDir, { recursive: true });
    await fs.writeFile(sentinelPath, "keep", "utf8");
    const runner = vi.fn(async () => successfulCommandResult());

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/existing-worktree",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow(
      `baseline worktree path already exists; refusing to reuse ${baselineWorktreeDir}`,
    );
    expect(runner).not.toHaveBeenCalled();
    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("keep");
  });

  it("fails closed when the worktree parent is replaced before fallback cleanup", async () => {
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "mantis",
      "cleanup-parent-replaced",
    );
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const worktreeParentDir = path.dirname(baselineWorktreeDir);
    const displacedParentDir = path.join(repoRoot, "displaced-worktree-parent");
    const displacedSentinelPath = path.join(displacedParentDir, "baseline", "keep.txt");
    const replacementSentinelPath = path.join(baselineWorktreeDir, "replacement.txt");
    const stages: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      stages.push(`${execution.stage}:${args[1] ?? ""}`);
      if (command === "git" && execution.stage === "worktree-add") {
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          await fs.writeFile(path.join(baselineWorktreeDir, "keep.txt"), "keep", "utf8");
          await fs.rename(worktreeParentDir, displacedParentDir);
          await fs.mkdir(baselineWorktreeDir, { recursive: true });
          await fs.writeFile(replacementSentinelPath, "replacement", "utf8");
          return failedCommandResult();
        }
        return successfulCommandResult("");
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-parent-replaced",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect((aggregate.errors[1] as Error).message).toContain(
        `Mantis worktree path was replaced before cleanup: ${baselineWorktreeDir}`,
      );
    }

    expect(stages).toEqual([
      "worktree-add:add",
      `qa:${baselineWorktreeDir}`,
      "worktree-cleanup:remove",
      "worktree-cleanup:list",
    ]);
    await expect(fs.readFile(displacedSentinelPath, "utf8")).resolves.toBe("keep");
    await expect(fs.readFile(replacementSentinelPath, "utf8")).resolves.toBe("replacement");
  });

  it("fails closed after a successful Git cleanup when the worktree target was replaced", async () => {
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "mantis",
      "cleanup-target-replaced",
    );
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const displacedWorktreeDir = path.join(repoRoot, "displaced-worktree");
    const displacedSentinelPath = path.join(displacedWorktreeDir, "keep.txt");
    const replacementSentinelPath = path.join(baselineWorktreeDir, "replacement.txt");
    const stages: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      stages.push(`${execution.stage}:${args[1] ?? ""}`);
      if (command === "git" && execution.stage === "worktree-add") {
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          await fs.writeFile(path.join(baselineWorktreeDir, "keep.txt"), "keep", "utf8");
          await fs.rename(baselineWorktreeDir, displacedWorktreeDir);
          await fs.mkdir(baselineWorktreeDir);
          await fs.writeFile(replacementSentinelPath, "replacement", "utf8");
          return successfulCommandResult();
        }
        return successfulCommandResult("");
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-target-replaced",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect((aggregate.errors[1] as Error).message).toContain(
        `Mantis worktree path was replaced before cleanup: ${baselineWorktreeDir}`,
      );
    }

    expect(stages).toEqual([
      "worktree-add:add",
      `qa:${baselineWorktreeDir}`,
      "worktree-cleanup:remove",
      "worktree-cleanup:list",
    ]);
    await expect(fs.readFile(displacedSentinelPath, "utf8")).resolves.toBe("keep");
    await expect(fs.readFile(replacementSentinelPath, "utf8")).resolves.toBe("replacement");
  });

  it("accepts an already-absent unregistered worktree after Git cleanup fails", async () => {
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "mantis",
      "cleanup-already-absent",
    );
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          await fs.rm(String(args[4]), { force: true, recursive: true });
          return failedCommandResult();
        }
        return successfulCommandResult("");
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-already-absent",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    });

    expect(result.status).toBe("pass");
    await expect(fs.stat(path.join(outputDir, "worktrees", "baseline"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(outputDir, "worktrees", "candidate"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps workload failure first when cleanup also fails", async () => {
    const workloadError = new Error("workload failed");
    const cleanupError = new Error("cleanup failed");
    const runner = vi.fn(async (_command: string, _args: readonly string[], execution) => {
      if (execution.stage === "worktree-add") {
        throw workloadError;
      }
      throw cleanupError;
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/aggregate-failure",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect(aggregate.message).toBe("Mantis lane failed and worktree cleanup failed");
      expect(aggregate.cause).toBeInstanceOf(Error);
      expect((aggregate.cause as Error).message).toContain("baseline worktree-add failed to run");
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(aggregate.cause);
      expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
      const cleanupAggregate = aggregate.errors[1] as AggregateError;
      expect(cleanupAggregate.errors[0]).toBeInstanceOf(Error);
      expect((cleanupAggregate.errors[0] as Error).message).toContain(
        "baseline worktree-cleanup failed to run",
      );
    }
  });

  it("removes a Mantis-owned partial lane directory only after exact registration is absent", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-unregistered");
    const listCalls: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        expect(args).toEqual(["worktree", "list", "--porcelain", "-z"]);
        listCalls.push(listCalls.length === 0 ? "baseline" : "candidate");
        return successfulCommandResult("");
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-unregistered",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    });

    expect(result.status).toBe("pass");
    expect(listCalls).toEqual(["baseline", "candidate"]);
    await expect(fs.stat(path.join(outputDir, "worktrees", "baseline"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(outputDir, "worktrees", "candidate"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when cleanup registration output is truncated", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-truncated");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const stages: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      stages.push(`${execution.stage}:${args[1]}`);
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        return {
          ...successfulCommandResult(""),
          stdoutTruncatedBytes: 1,
        } satisfies StubCommandResult;
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-truncated",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect(aggregate.message).toContain(
        `baseline worktree cleanup could not verify complete registration state for ${baselineWorktreeDir}`,
      );
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBeInstanceOf(Error);
      expect((aggregate.errors[0] as Error).message).toContain(
        "baseline worktree-cleanup failed with exit code 1",
      );
      expect((aggregate.errors[1] as Error).message).toContain("truncated registration output");
    }
    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
    expect(stages).toEqual([
      "worktree-add:add",
      `qa:${baselineWorktreeDir}`,
      "worktree-cleanup:remove",
      "worktree-cleanup:list",
    ]);
  });

  it("leaves a registered exact worktree path for operator cleanup", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-registered");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const stages: string[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      stages.push(`${execution.stage}:${args[1]}`);
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        return successfulCommandResult(worktreeListOutput(baselineWorktreeDir));
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/cleanup-registered",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow(`baseline worktree cleanup left registered path ${baselineWorktreeDir}`);

    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
    expect(stages).toEqual([
      "worktree-add:add",
      `qa:${baselineWorktreeDir}`,
      "worktree-cleanup:remove",
      "worktree-cleanup:list",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "treats a registered symlink alias as the exact POSIX worktree path",
    async () => {
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-alias");
      const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
      const aliasDir = path.join(repoRoot, "baseline-alias");
      const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
        if (command === "git" && execution.stage === "worktree-add") {
          await fs.mkdir(String(args[4]), { recursive: true });
          await fs.symlink(String(args[4]), aliasDir);
          return successfulCommandResult();
        }
        if (command === "pnpm" && execution.stage === "qa") {
          await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
          return successfulCommandResult();
        }
        if (command === "git" && execution.stage === "worktree-cleanup") {
          if (args[1] === "remove") {
            return failedCommandResult();
          }
          return successfulCommandResult(worktreeListOutput(aliasDir));
        }
        throw new Error(`unexpected ${execution.stage} command`);
      });

      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          outputDir: ".artifacts/qa-e2e/mantis/cleanup-alias",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow(`baseline worktree cleanup left registered path ${baselineWorktreeDir}`);

      await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
    },
  );

  it("keeps workload timeout before registered-path cleanup failure in objects and diagnostics", async () => {
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "mantis",
      "timeout-cleanup-registered",
    );
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        return timedOutCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          return failedCommandResult();
        }
        return successfulCommandResult(worktreeListOutput(baselineWorktreeDir));
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      commandTimeouts: { qa: 321 },
      outputDir: ".artifacts/qa-e2e/mantis/timeout-cleanup-registered",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect((aggregate.errors[0] as Error).message).toContain("baseline qa timed out after 321ms");
      expect((aggregate.errors[1] as Error).message).toContain(
        `baseline worktree cleanup left registered path ${baselineWorktreeDir}`,
      );
    }
    const errorText = await fs.readFile(path.join(outputDir, "error.txt"), "utf8");
    const outerIndex = errorText.indexOf("Mantis lane failed and worktree cleanup failed");
    const timeoutIndex = errorText.indexOf("baseline qa timed out after 321ms");
    const cleanupIndex = errorText.indexOf(
      `baseline worktree cleanup left registered path ${baselineWorktreeDir}`,
    );
    expect(outerIndex).toBeGreaterThanOrEqual(0);
    expect(timeoutIndex).toBeGreaterThan(outerIndex);
    expect(cleanupIndex).toBeGreaterThan(timeoutIndex);
  });

  it("preserves remove failure first when registration listing fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-list-fails");
    const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        return failedCommandResult(args[1] === "remove" ? 1 : 2);
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    const result = await runMantisBeforeAfter({
      baseline: "baseline-ref",
      candidate: "candidate-ref",
      commandRunner: runner,
      outputDir: ".artifacts/qa-e2e/mantis/cleanup-list-fails",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    }).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toBeInstanceOf(AggregateError);
      const aggregate = result.error as AggregateError;
      expect((aggregate.errors[0] as Error).message).toContain(
        "baseline worktree-cleanup failed with exit code 1",
      );
      expect((aggregate.errors[1] as Error).message).toContain(
        "baseline worktree-cleanup failed with exit code 2",
      );
    }
    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
  });
});
