// Qa Lab tests cover run plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QA_EVIDENCE_FILENAME, buildQaSuiteEvidenceSummary } from "../evidence-summary.js";
import { publishMantisRunOutput } from "./run-artifacts.runtime.js";
import { runMantisBeforeAfter } from "./run.runtime.js";
import {
  failedCommandResult,
  requireArgAfter,
  successfulCommandResult,
  timedOutCommandResult,
  writeLegacyLaneSummary,
  worktreeListOutput,
} from "./run.test-support.js";

describe("mantis before/after runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("runs baseline and candidate worktrees and writes stable comparison artifacts", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "test-run");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "error.txt"), "stale failure", "utf8");
    await fs.writeFile(path.join(outputDir, "unrelated.txt"), "preserve me", "utf8");
    const commands: { args: readonly string[]; command: string; stage: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      commands.push({ command, args, stage: execution.stage });
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          await fs.rm(execution.cwd, { force: true, recursive: true });
        }
        return successfulCommandResult();
      }
      if (command !== "pnpm" || !args.includes("openclaw")) {
        return successfulCommandResult();
      }
      const repoRootArg = requireArgAfter(args, "--repo-root");
      const outputDirArg = requireArgAfter(args, "--output-dir");
      const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
      const laneOutputDir = path.join(repoRootArg, outputDirArg);
      await fs.mkdir(laneOutputDir, { recursive: true });
      const screenshotPath = path.join(laneOutputDir, `${lane}-timeline.png`);
      const videoPath = path.join(laneOutputDir, `${lane}-timeline.mp4`);
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
        path.join(laneOutputDir, QA_EVIDENCE_FILENAME),
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
    expect(commands).toHaveLength(8);
    expect(commands.map((entry) => entry.stage)).toEqual([
      "worktree-add",
      "qa",
      "worktree-cleanup",
      "worktree-cleanup",
      "worktree-add",
      "qa",
      "worktree-cleanup",
      "worktree-cleanup",
    ]);
    const baselineWorktreeDir = String(commands[0]?.args[4]);
    const candidateWorktreeDir = String(commands[4]?.args[4]);
    expect(path.dirname(baselineWorktreeDir)).toBe(`${outputDir}.worktrees`);
    expect(path.basename(baselineWorktreeDir)).toMatch(/^baseline-/u);
    expect(path.dirname(candidateWorktreeDir)).toBe(`${outputDir}.worktrees`);
    expect(path.basename(candidateWorktreeDir)).toMatch(/^candidate-/u);
    expect(commands[0]?.command).toBe("git");
    expect(commands[0]?.args).toEqual([
      "worktree",
      "add",
      "--detach",
      "--",
      baselineWorktreeDir,
      "--lock",
    ]);
    expect(commands[1]?.command).toBe("pnpm");
    expect(commands[1]?.args[0]).toBe("--dir");
    expect(commands[1]?.args[1]).toBe(baselineWorktreeDir);
    expect(commands[1]?.args.slice(2, 4)).toEqual(["openclaw", "qa"]);
    expect(commands[2]?.command).toBe("git");
    expect(commands[2]?.args).toEqual(["worktree", "remove", "--force", "--", "."]);
    expect(commands[3]?.args).toEqual(["worktree", "list", "--porcelain", "-z"]);
    expect(commands[4]?.command).toBe("git");
    expect(commands[4]?.args).toEqual([
      "worktree",
      "add",
      "--detach",
      "--",
      candidateWorktreeDir,
      "--force",
    ]);
    expect(commands[5]?.command).toBe("pnpm");
    expect(commands[5]?.args[0]).toBe("--dir");
    expect(commands[5]?.args[1]).toBe(candidateWorktreeDir);
    expect(commands[5]?.args.slice(2, 4)).toEqual(["openclaw", "qa"]);
    expect(commands[6]?.command).toBe("git");
    expect(commands[6]?.args).toEqual(["worktree", "remove", "--force", "--", "."]);
    expect(commands[7]?.args).toEqual(["worktree", "list", "--porcelain", "-z"]);

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
    await expect(fs.stat(path.join(result.outputDir, "error.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(result.outputDir, "unrelated.txt"), "utf8")).resolves.toBe(
      "preserve me",
    );
    expect(
      (await fs.readdir(result.outputDir)).filter(
        (entry) => entry.startsWith(".mantis-staged-") || entry.startsWith(".mantis-previous-"),
      ),
    ).toEqual([]);
    await expect(fs.stat(baselineWorktreeDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(candidateWorktreeDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects the repo root as an output container before preparing worktrees", async () => {
    const runner = vi.fn();
    await expect(
      runMantisBeforeAfter({
        commandRunner: runner,
        outputDir: ".",
        repoRoot,
      }),
    ).rejects.toThrow("--output-dir must stay within the repo root.");
    expect(runner).not.toHaveBeenCalled();
  });

  it("supports the Discord thread filePath attachment Mantis scenario", async () => {
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          await fs.rm(execution.cwd, { force: true, recursive: true });
        }
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
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "mantis",
      `${scenario}-deadlines`,
    );
    const executions: { stage: string; timeoutMs: number }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      executions.push({ stage: execution.stage, timeoutMs: execution.timeoutMs });
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
      }
      if (command === "git" && execution.stage === "worktree-cleanup" && args[1] === "remove") {
        await fs.rm(execution.cwd, { force: true, recursive: true });
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
    await expect(fs.readdir(`${outputDir}.worktrees`)).resolves.toEqual([]);
    expect(executions).toEqual([
      { stage: "worktree-add", timeoutMs: 300_000 },
      { stage: "install", timeoutMs: 1_800_000 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: qaTimeoutMs },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
      { stage: "worktree-add", timeoutMs: 300_000 },
      { stage: "install", timeoutMs: 1_800_000 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: qaTimeoutMs },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
    ]);
    for (const execution of executions.filter((entry) => entry.stage === "worktree-cleanup")) {
      expect(execution.timeoutMs).toBeGreaterThan(0);
      expect(execution.timeoutMs).toBeLessThanOrEqual(120_000);
    }
  });

  it("normalizes command timeout overrides per stage", async () => {
    const executions: { stage: string; timeoutMs: number }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      executions.push({ stage: execution.stage, timeoutMs: execution.timeoutMs });
      if (command === "git" && execution.stage === "worktree-add") {
        await fs.mkdir(String(args[4]), { recursive: true });
      }
      if (command === "git" && execution.stage === "worktree-cleanup" && args[1] === "remove") {
        await fs.rm(execution.cwd, { force: true, recursive: true });
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

    expect(executions.slice(0, 6)).toEqual([
      { stage: "worktree-add", timeoutMs: 111 },
      { stage: "install", timeoutMs: 222 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: 444 },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
      { stage: "worktree-cleanup", timeoutMs: expect.any(Number) },
    ]);
    for (const execution of executions.filter((entry) => entry.stage === "worktree-cleanup")) {
      expect(execution.timeoutMs).toBeGreaterThan(0);
      expect(execution.timeoutMs).toBeLessThanOrEqual(120_000);
    }
  });

  it("does not prepare or dispatch a worktree when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn(async () => successfulCommandResult());
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "pre-aborted");

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
    await expect(fs.readdir(`${outputDir}.worktrees`)).resolves.toEqual([]);
  });

  it("cleans up the exact worktree path after worktree-add times out", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "add-timeout");
    let baselineWorktreeDir = "";
    let registered = false;
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
        baselineWorktreeDir = String(args[4]);
        await fs.mkdir(baselineWorktreeDir, { recursive: true });
        registered = true;
        return timedOutCommandResult();
      }
      if (execution.stage === "worktree-cleanup" && args[1] === "remove") {
        await fs.rm(execution.cwd, { force: true, recursive: true });
        registered = false;
      }
      if (execution.stage === "worktree-cleanup" && args[1] === "list") {
        return successfulCommandResult(registered ? worktreeListOutput(baselineWorktreeDir) : "");
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

    expect(path.dirname(baselineWorktreeDir)).toBe(`${outputDir}.worktrees`);
    expect(path.basename(baselineWorktreeDir)).toMatch(/^baseline-/u);
    expect(calls).toEqual([
      {
        args: ["worktree", "add", "--detach", "--", baselineWorktreeDir, "baseline-ref"],
        command: "git",
        signal: undefined,
        stage: "worktree-add",
        timeoutMs: 123,
      },
      {
        args: ["worktree", "remove", "--force", "--", "."],
        command: "git",
        signal: undefined,
        stage: "worktree-cleanup",
        timeoutMs: expect.any(Number),
      },
      {
        args: ["worktree", "list", "--porcelain", "-z"],
        command: "git",
        signal: undefined,
        stage: "worktree-cleanup",
        timeoutMs: expect.any(Number),
      },
    ]);
    for (const call of calls.filter((entry) => entry.stage === "worktree-cleanup")) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(456);
    }
  });

  it("writes top-level failure diagnostics when the candidate lane fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "candidate-failure");
    await fs.mkdir(path.join(outputDir, "baseline"), { recursive: true });
    await fs.mkdir(path.join(outputDir, "candidate"), { recursive: true });
    await fs.writeFile(path.join(outputDir, "baseline", "old.txt"), "old baseline", "utf8");
    await fs.writeFile(path.join(outputDir, "candidate", "old.txt"), "old candidate", "utf8");
    for (const fileName of ["comparison.json", "mantis-report.md", "mantis-evidence.json"]) {
      await fs.writeFile(path.join(outputDir, fileName), `old ${fileName}`, "utf8");
    }
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        if (path.basename(String(args[4])).startsWith("candidate-")) {
          return failedCommandResult();
        }
        await fs.mkdir(String(args[4]), { recursive: true });
        return successfulCommandResult();
      }
      if (command === "pnpm" && execution.stage === "qa") {
        await writeLegacyLaneSummary({ args, scenario: "discord-status-reactions-tool-only" });
        return successfulCommandResult();
      }
      if (command === "git" && execution.stage === "worktree-cleanup") {
        if (args[1] === "remove") {
          await fs.rm(execution.cwd, { force: true, recursive: true });
        }
        return successfulCommandResult();
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/candidate-failure",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow("candidate worktree-add");

    await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toContain(
      "candidate worktree-add",
    );
    await expect(fs.readFile(path.join(outputDir, "baseline", "old.txt"), "utf8")).resolves.toBe(
      "old baseline",
    );
    await expect(fs.readFile(path.join(outputDir, "candidate", "old.txt"), "utf8")).resolves.toBe(
      "old candidate",
    );
    for (const fileName of ["comparison.json", "mantis-report.md", "mantis-evidence.json"]) {
      await expect(fs.readFile(path.join(outputDir, fileName), "utf8")).resolves.toBe(
        `old ${fileName}`,
      );
    }
    expect(
      (await fs.readdir(outputDir)).filter((entry) => entry.startsWith(".mantis-staged-")),
    ).toEqual([]);
  });

  it("rolls the complete stable artifact set back when publication fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "rollback");
    const staging = {
      dir: path.join(outputDir, ".mantis-staged-test"),
      relative: ".mantis-staged-test",
    };
    const stableFiles = ["comparison.json", "mantis-report.md", "mantis-evidence.json"];
    for (const lane of ["baseline", "candidate"]) {
      await fs.mkdir(path.join(outputDir, lane), { recursive: true });
      await fs.writeFile(path.join(outputDir, lane, "old.txt"), `old ${lane}`, "utf8");
      await fs.mkdir(path.join(staging.dir, lane), { recursive: true });
      await fs.writeFile(path.join(staging.dir, lane, "new.txt"), `new ${lane}`, "utf8");
    }
    for (const fileName of stableFiles) {
      await fs.writeFile(path.join(outputDir, fileName), `old ${fileName}`, "utf8");
      await fs.writeFile(path.join(staging.dir, fileName), `new ${fileName}`, "utf8");
    }
    const outputRoot = await root(outputDir);
    const publicationError = new Error("candidate publication failed");

    await expect(
      publishMantisRunOutput({
        outputRoot: {
          exists: outputRoot.exists.bind(outputRoot),
          list: outputRoot.list.bind(outputRoot),
          mkdir: outputRoot.mkdir.bind(outputRoot),
          move: vi.fn(async (from, to, options) => {
            if (from === `${staging.relative}/candidate` && to === "candidate") {
              throw publicationError;
            }
            await outputRoot.move(from, to, options);
          }),
          remove: outputRoot.remove.bind(outputRoot),
          stat: outputRoot.stat.bind(outputRoot),
        },
        runId: "test",
        staging,
      }),
    ).rejects.toBe(publicationError);

    for (const lane of ["baseline", "candidate"]) {
      await expect(fs.readFile(path.join(outputDir, lane, "old.txt"), "utf8")).resolves.toBe(
        `old ${lane}`,
      );
    }
    for (const fileName of stableFiles) {
      await expect(fs.readFile(path.join(outputDir, fileName), "utf8")).resolves.toBe(
        `old ${fileName}`,
      );
    }
    expect(
      (await fs.readdir(outputDir)).filter(
        (entry) => entry.startsWith(".mantis-staged-") || entry.startsWith(".mantis-previous-"),
      ),
    ).toEqual([]);
  });

  it("retains the owned worktree and writes diagnostics when cleanup fails", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "cleanup-failure");
    let baselineWorktreeDir = "";
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      if (command === "git" && execution.stage === "worktree-add") {
        baselineWorktreeDir = String(args[4]);
        await fs.mkdir(baselineWorktreeDir, { recursive: true });
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
        outputDir: ".artifacts/qa-e2e/mantis/cleanup-failure",
        repoRoot,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow("baseline worktree cleanup left registered path");

    await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toContain(
      "baseline worktree cleanup left registered path",
    );
    await expect(fs.stat(baselineWorktreeDir)).resolves.toBeDefined();
  });

  it("accepts an already-absent unregistered worktree after Git cleanup fails", async () => {
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "mantis",
      "cleanup-already-absent",
    );
    const removedWorktreeDirs: string[] = [];
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
          removedWorktreeDirs.push(execution.cwd);
          await fs.rm(execution.cwd, { force: true, recursive: true });
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
    expect(removedWorktreeDirs).toHaveLength(2);
    expect(removedWorktreeDirs.map((entry) => path.basename(entry))).toEqual([
      expect.stringMatching(/^baseline-/u),
      expect.stringMatching(/^candidate-/u),
    ]);
    await expect(fs.readdir(`${outputDir}.worktrees`)).resolves.toEqual([]);
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
      const errorPath = path.join(repoRoot, ".artifacts/qa-e2e/mantis/aggregate-failure/error.txt");
      expect(aggregate.message).toContain("Mantis lane failed and worktree cleanup failed");
      expect(aggregate.message).toContain(errorPath);
      expect(aggregate.cause).toBeInstanceOf(Error);
      expect((aggregate.cause as Error).message).toContain("baseline worktree-add failed to run");
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(aggregate.cause);
      expect(aggregate.errors[1]).toBeInstanceOf(Error);
      expect((aggregate.errors[1] as Error).message).toContain(
        "baseline worktree cleanup could not verify complete registration state",
      );
    }
  });

  it("copies lane artifacts before asking Git to remove the worktree", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "publish-order");
    const events: string[] = [];
    const originalCopy = fs.cp.bind(fs);
    const copy = vi.spyOn(fs, "cp").mockImplementation(async (source, target, options) => {
      const sourcePath = String(source);
      if (sourcePath.startsWith(`${outputDir}.worktrees${path.sep}`)) {
        const artifactMarker = `${path.sep}.artifacts${path.sep}`;
        events.push(`copy:${sourcePath.slice(0, sourcePath.lastIndexOf(artifactMarker))}`);
      }
      await originalCopy(source, target, options);
    });
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
          events.push(`remove:${execution.cwd}`);
          await fs.rm(execution.cwd, { force: true, recursive: true });
        }
        return successfulCommandResult();
      }
      throw new Error(`unexpected ${execution.stage} command`);
    });

    try {
      await expect(
        runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandRunner: runner,
          outputDir: ".artifacts/qa-e2e/mantis/publish-order",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        }),
      ).resolves.toMatchObject({ status: "pass" });
    } finally {
      copy.mockRestore();
    }

    const copies = events.filter((event) => event.startsWith("copy:"));
    const removals = events.filter((event) => event.startsWith("remove:"));
    expect(copies).toHaveLength(2);
    expect(removals).toHaveLength(2);
    for (const copyEvent of copies) {
      const worktreeDir = copyEvent.slice("copy:".length);
      expect(events.indexOf(copyEvent)).toBeLessThan(events.indexOf(`remove:${worktreeDir}`));
    }
  });
});
