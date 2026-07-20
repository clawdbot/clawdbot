// Qa Lab tests cover run plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
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

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(filePath: string, timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      const pid = Number(await fs.readFile(filePath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // retry until the process writes its pid
    }
    await sleep(5);
  }
  throw new Error(`timeout waiting for pid in ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`process ${pid} still alive`);
}

async function runGit(repoRoot: string, args: readonly string[]) {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd: repoRoot,
    env: process.env,
    killProcessTree: true,
    outputCapture: "buffer",
    timeoutMs: 5_000,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
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
      expect(aggregate.errors[1]).toBeInstanceOf(Error);
      expect((aggregate.errors[1] as Error).message).toContain(
        "baseline worktree-cleanup failed to run",
      );
    }
  });

  it("stops an active injected lane command when aborted", async () => {
    const controller = new AbortController();
    const stages: string[] = [];
    const runner = vi.fn(async (_command: string, _args: readonly string[], execution) => {
      stages.push(execution.stage);
      if (execution.stage !== "worktree-add") {
        expect(execution.stage).toBe("worktree-cleanup");
        expect(execution.signal).toBeUndefined();
        return successfulCommandResult();
      }
      expect(execution.signal).toBe(controller.signal);
      queueMicrotask(() => controller.abort());
      return await new Promise<StubCommandResult>((resolve) => {
        execution.signal?.addEventListener(
          "abort",
          () =>
            resolve({
              code: null,
              killed: true,
              signal: "SIGTERM",
              stderr: "",
              stdout: "",
              termination: "signal",
            }),
          { once: true },
        );
      });
    });

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/injected-abort",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow("baseline worktree-add aborted");
    expect(stages).toEqual(["worktree-add", "worktree-cleanup"]);
  });

  it("keeps signal termination ahead of a normalized successful exit", async () => {
    const controller = new AbortController();
    const stages: string[] = [];
    const runner = vi.fn(async (_command: string, _args: readonly string[], execution) => {
      stages.push(execution.stage);
      if (execution.stage === "worktree-cleanup") {
        expect(execution.signal).toBeUndefined();
        return successfulCommandResult();
      }
      expect(execution.stage).toBe("worktree-add");
      expect(execution.signal).toBe(controller.signal);
      controller.abort();
      return {
        code: 0,
        killed: true,
        signal: "SIGTERM",
        stderr: "",
        stdout: "",
        termination: "signal",
      } satisfies StubCommandResult;
    });

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/signal-exit-zero",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow("baseline worktree-add aborted");
    expect(stages).toEqual(["worktree-add", "worktree-cleanup"]);
  });

  it.skipIf(process.platform === "win32")(
    "stops a default-runner lane command process tree when aborted",
    async () => {
      const controller = new AbortController();
      const binDir = path.join(repoRoot, "bin");
      const parentPidPath = path.join(repoRoot, "abort-parent.pid");
      const descendantPidPath = path.join(repoRoot, "abort-descendant.pid");
      const gitShimPath = path.join(binDir, "git");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        gitShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = worktree ] && [ "$2" = remove ]; then rm -rf "$5"; exit 0; fi',
          "trap '' TERM",
          `printf '%s' "$$" > ${JSON.stringify(parentPidPath)}`,
          "sh -c 'trap \"\" TERM; while :; do sleep 1; done' &",
          `printf '%s' "$!" > ${JSON.stringify(descendantPidPath)}`,
          "while :; do sleep 1; done",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );

      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      const run = runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        outputDir: ".artifacts/qa-e2e/mantis/default-runner-abort",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      });
      const settled = run.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      try {
        [parentPid, descendantPid] = await Promise.all([
          readPid(parentPidPath, 2_000),
          readPid(descendantPidPath, 2_000),
        ]);
        controller.abort();

        const result = await Promise.race([
          settled,
          sleep(4_000).then(() => {
            throw new Error("timed out waiting for Mantis abort rejection");
          }),
        ]);
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toContain("baseline worktree-add aborted");
        }
        await Promise.all([waitForDead(parentPid, 2_000), waitForDead(descendantPid, 2_000)]);
      } finally {
        controller.abort();
        await Promise.race([settled, sleep(4_000)]);
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        for (const pid of [parentPid, descendantPid]) {
          if (pid !== undefined && isProcessRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "cleans up a real git worktree after a noisy QA deadline kills its process tree",
    async () => {
      const qaTimeoutMs = 900;
      const binDir = path.join(repoRoot, "bin");
      const parentPidPath = path.join(repoRoot, "qa-parent.pid");
      const descendantPidPath = path.join(repoRoot, "qa-descendant.pid");
      const pnpmShimPath = path.join(binDir, "pnpm");
      await runGit(repoRoot, ["init"]);
      await fs.writeFile(path.join(repoRoot, "seed.txt"), "seed\n", "utf8");
      await runGit(repoRoot, ["add", "seed.txt"]);
      await runGit(repoRoot, [
        "-c",
        "user.name=Mantis Test",
        "-c",
        "user.email=mantis@example.test",
        "commit",
        "-m",
        "seed",
      ]);
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        pnpmShimPath,
        [
          "#!/bin/sh",
          "trap '' TERM",
          `printf '%s' "$$" > ${JSON.stringify(parentPidPath)}`,
          "sh -c 'trap \"\" TERM; while :; do sleep 1; done' &",
          `printf '%s' "$!" > ${JSON.stringify(descendantPidPath)}`,
          "while :; do printf 'qa still working\\n'; sleep 0.05; done",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );

      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      const controller = new AbortController();
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "real-qa-timeout");
      const baselineWorktreeDir = path.join(outputDir, "worktrees", "baseline");
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      const run = runMantisBeforeAfter({
        baseline: "HEAD",
        candidate: "HEAD",
        commandTimeouts: { qa: qaTimeoutMs, "worktree-cleanup": 5_000 },
        outputDir: ".artifacts/qa-e2e/mantis/real-qa-timeout",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      });
      const settled = run.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      try {
        [parentPid, descendantPid] = await Promise.all([
          readPid(parentPidPath, 2_000),
          readPid(descendantPidPath, 2_000),
        ]);

        const result = await Promise.race([
          settled,
          sleep(6_000).then(() => {
            throw new Error("timed out waiting for Mantis QA deadline rejection");
          }),
        ]);
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toContain(
            `baseline qa timed out after ${qaTimeoutMs}ms`,
          );
        }
        await Promise.all([waitForDead(parentPid, 2_000), waitForDead(descendantPid, 2_000)]);
        const worktreeList = await runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
        const worktreeEntries = worktreeList.stdout
          .split("\0")
          .filter((entry) => entry.startsWith("worktree "))
          .map((entry) => entry.slice("worktree ".length));
        await expect(fs.realpath(worktreeEntries[0] ?? "")).resolves.toBe(
          await fs.realpath(repoRoot),
        );
        expect(worktreeEntries).toHaveLength(1);
        await expect(fs.stat(baselineWorktreeDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toContain(
          `baseline qa timed out after ${qaTimeoutMs}ms`,
        );
      } finally {
        controller.abort();
        await Promise.race([settled, sleep(6_000)]);
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        for (const pid of [parentPid, descendantPid]) {
          if (pid !== undefined && isProcessRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    },
    12_000,
  );

  it.skipIf(process.platform === "win32")(
    "stops a noisy lane command at its total deadline and kills its process tree",
    async () => {
      const worktreeAddTimeoutMs = 1_500;
      const binDir = path.join(repoRoot, "bin");
      const parentPidPath = path.join(repoRoot, "parent.pid");
      const descendantPidPath = path.join(repoRoot, "descendant.pid");
      const gitShimPath = path.join(binDir, "git");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        gitShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = worktree ] && [ "$2" = remove ]; then rm -rf "$5"; exit 0; fi',
          "trap '' TERM",
          `printf '%s' \"$$\" > ${JSON.stringify(parentPidPath)}`,
          "sh -c 'trap \"\" TERM; while :; do sleep 1; done' &",
          `printf '%s' \"$!\" > ${JSON.stringify(descendantPidPath)}`,
          "while :; do printf 'still working\\n'; sleep 0.05; done",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );

      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      const controller = new AbortController();
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      const run = runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandTimeouts: { "worktree-add": worktreeAddTimeoutMs },
        outputDir: ".artifacts/qa-e2e/mantis/timeout-run",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      });
      const settled = run.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      try {
        [parentPid, descendantPid] = await Promise.all([
          readPid(parentPidPath, 2_000),
          readPid(descendantPidPath, 2_000),
        ]);

        await expect(
          Promise.race([
            run,
            sleep(4_000).then(() => {
              throw new Error("timed out waiting for Mantis deadline rejection");
            }),
          ]),
        ).rejects.toThrow(`baseline worktree-add timed out after ${worktreeAddTimeoutMs}ms`);
        await Promise.all([waitForDead(parentPid, 2_000), waitForDead(descendantPid, 2_000)]);
      } finally {
        controller.abort();
        await Promise.race([settled, sleep(4_000)]);
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        for (const pid of [parentPid, descendantPid]) {
          if (pid !== undefined && isProcessRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
      }
    },
  );
});
