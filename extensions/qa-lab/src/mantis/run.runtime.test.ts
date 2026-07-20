// Qa Lab tests cover run plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

describe("mantis before/after runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("runs baseline and candidate worktrees and writes stable comparison artifacts", async () => {
    const commands: { args: readonly string[]; command: string; cwd?: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
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
    expect(
      commands.map((entry) => [
        entry.command,
        entry.args[0],
        entry.args[1],
        entry.args[2],
        entry.args[3],
      ]),
    ).toHaveLength(4);
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
    expect(commands[1]?.args[1]).toContain("baseline");
    expect(commands[1]?.args.slice(2, 4)).toEqual(["openclaw", "qa"]);
    expect(commands[2]?.command).toBe("git");
    expect(commands[2]?.args).toEqual([
      "worktree",
      "add",
      "--detach",
      "--",
      path.join(result.outputDir, "worktrees", "candidate"),
      "--force",
    ]);
    expect(commands[3]?.command).toBe("pnpm");
    expect(commands[3]?.args[0]).toBe("--dir");
    expect(commands[3]?.args[1]).toContain("candidate");
    expect(commands[3]?.args.slice(2, 4)).toEqual(["openclaw", "qa"]);

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
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.outputDir, "worktrees", "candidate")),
    ).resolves.toBeTruthy();
    expect(executions).toEqual([
      { stage: "worktree-add", timeoutMs: 300_000 },
      { stage: "install", timeoutMs: 1_800_000 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: qaTimeoutMs },
      { stage: "worktree-add", timeoutMs: 300_000 },
      { stage: "install", timeoutMs: 1_800_000 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: qaTimeoutMs },
    ]);
  });

  it("normalizes command timeout overrides per stage", async () => {
    const executions: { stage: string; timeoutMs: number }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[], execution) => {
      executions.push({ stage: execution.stage, timeoutMs: execution.timeoutMs });
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

    expect(executions.slice(0, 4)).toEqual([
      { stage: "worktree-add", timeoutMs: 111 },
      { stage: "install", timeoutMs: 222 },
      { stage: "build", timeoutMs: 1_800_000 },
      { stage: "qa", timeoutMs: 444 },
    ]);
  });

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
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        const run = runMantisBeforeAfter({
          baseline: "baseline-ref",
          candidate: "candidate-ref",
          commandTimeouts: { "worktree-add": worktreeAddTimeoutMs },
          outputDir: ".artifacts/qa-e2e/mantis/timeout-run",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        });
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
