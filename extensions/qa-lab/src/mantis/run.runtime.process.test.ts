// Qa Lab tests cover Mantis run process behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisBeforeAfter } from "./run.runtime.js";

type StubCommandResult = {
  code: number | null;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
};

function successfulCommandResult(stdout = ""): StubCommandResult {
  return { code: 0, killed: false, signal: null, stderr: "", stdout, termination: "exit" };
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

type SettledRun = { status: "fulfilled" } | { error: unknown; status: "rejected" };

function describeSettledRun(settled: SettledRun) {
  if (settled.status === "fulfilled") {
    return "fulfilled";
  }
  if (settled.error instanceof Error) {
    return `rejected with ${settled.error.name}: ${settled.error.message}`;
  }
  return `rejected with ${String(settled.error)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}

function killKnownProcessPids(pids: ReadonlyArray<number | undefined>) {
  for (const pid of pids) {
    if (pid !== undefined && isProcessRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // process exited between liveness check and SIGKILL
      }
    }
  }
}

async function readPidBeforeSettled(
  filePath: string,
  label: string,
  timeoutMs: number,
  settled: Promise<SettledRun>,
) {
  const result = await Promise.race([
    readPid(filePath, timeoutMs).then((pid) => ({ pid, status: "ready" as const })),
    settled.then((settledResult) => ({ settled: settledResult, status: "settled" as const })),
  ]);
  if (result.status === "ready") {
    return result.pid;
  }
  throw new Error(
    `Mantis run settled before ${label} pid readiness: ${describeSettledRun(result.settled)}`,
  );
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

function shellWord(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stubbornProcessTreeShellLines(params: {
  descendantPidPath: string;
  outputLine?: string;
  parentPidPath: string;
}) {
  const descendantScript = [
    'printf \'%s\' "$$" > "$1"',
    "trap '' TERM",
    "while :; do sleep 1; done",
  ].join("\n");
  const outputLoop = params.outputLine
    ? `while :; do printf ${shellWord(`${params.outputLine}\\n`)}; sleep 0.05; done`
    : "while :; do sleep 1; done";
  return [
    `printf '%s' "$$" > ${shellWord(params.parentPidPath)}`,
    `/bin/sh -c ${shellWord(descendantScript)} sh ${shellWord(params.descendantPidPath)} &`,
    "trap '' TERM",
    outputLoop,
  ];
}

async function runGit(repoRoot: string, args: readonly string[]) {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd: repoRoot,
    env: process.env,
    killProcessTree: true,
    timeoutMs: 5_000,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

describe("mantis before/after process runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-process-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
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
          'if [ "$1" = worktree ] && [ "$2" = remove ]; then',
          "  worktree_path=",
          "  previous_arg=",
          '  for arg in "$@"; do',
          '    if [ "$previous_arg" = -- ]; then worktree_path=$arg; break; fi',
          "    previous_arg=$arg",
          "  done",
          '  if [ -z "$worktree_path" ]; then worktree_path=$5; fi',
          '  rm -rf -- "$worktree_path"',
          "  exit 0",
          "fi",
          'if [ "$1" != worktree ] || [ "$2" != add ]; then',
          "  printf 'unexpected git shim invocation:' >&2",
          "  printf ' %s' \"$@\" >&2",
          "  printf '\\n' >&2",
          "  exit 1",
          "fi",
          ...stubbornProcessTreeShellLines({ descendantPidPath, parentPidPath }),
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
          readPidBeforeSettled(parentPidPath, "parent", 5_000, settled),
          readPidBeforeSettled(descendantPidPath, "descendant", 5_000, settled),
        ]);
        controller.abort();

        const result = await withTimeout(
          settled,
          4_000,
          "timed out waiting for Mantis abort rejection",
        );
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toContain("baseline worktree-add aborted");
        }
        await Promise.all([waitForDead(parentPid, 2_000), waitForDead(descendantPid, 2_000)]);
      } finally {
        controller.abort();
        killKnownProcessPids([parentPid, descendantPid]);
        try {
          await withTimeout(
            settled,
            4_000,
            "timed out waiting for Mantis abort teardown to settle",
          );
        } finally {
          if (previousPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = previousPath;
          }
          killKnownProcessPids([parentPid, descendantPid]);
        }
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "cleans up a real git worktree after a noisy QA deadline kills its process tree",
    async () => {
      const qaTimeoutMs = 2_500;
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
          ...stubbornProcessTreeShellLines({
            descendantPidPath,
            outputLine: "qa still working",
            parentPidPath,
          }),
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
        // Keep the tested deadline after process-tree readiness under loaded CI while still short.
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
          readPidBeforeSettled(parentPidPath, "parent", 5_000, settled),
          readPidBeforeSettled(descendantPidPath, "descendant", 5_000, settled),
        ]);

        const result = await withTimeout(
          settled,
          6_000,
          "timed out waiting for Mantis QA deadline rejection",
        );
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
        killKnownProcessPids([parentPid, descendantPid]);
        try {
          await withTimeout(
            settled,
            6_000,
            "timed out waiting for Mantis QA deadline teardown to settle",
          );
        } finally {
          if (previousPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = previousPath;
          }
          killKnownProcessPids([parentPid, descendantPid]);
        }
      }
    },
    18_000,
  );

  it.skipIf(process.platform === "win32")(
    "stops a noisy lane command at its total deadline and kills its process tree",
    async () => {
      const worktreeAddTimeoutMs = 2_500;
      const binDir = path.join(repoRoot, "bin");
      const parentPidPath = path.join(repoRoot, "parent.pid");
      const descendantPidPath = path.join(repoRoot, "descendant.pid");
      const gitShimPath = path.join(binDir, "git");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        gitShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = worktree ] && [ "$2" = remove ]; then rm -rf -- "$5"; exit 0; fi',
          ...stubbornProcessTreeShellLines({
            descendantPidPath,
            outputLine: "still working",
            parentPidPath,
          }),
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
        // Keep the tested deadline after process-tree readiness under loaded CI while still short.
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
          readPidBeforeSettled(parentPidPath, "parent", 5_000, settled),
          readPidBeforeSettled(descendantPidPath, "descendant", 5_000, settled),
        ]);

        const result = await withTimeout(
          settled,
          4_000,
          "timed out waiting for Mantis deadline rejection",
        );
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toContain(
            `baseline worktree-add timed out after ${worktreeAddTimeoutMs}ms`,
          );
        }
        await Promise.all([waitForDead(parentPid, 2_000), waitForDead(descendantPid, 2_000)]);
      } finally {
        controller.abort();
        killKnownProcessPids([parentPid, descendantPid]);
        try {
          await withTimeout(
            settled,
            4_000,
            "timed out waiting for Mantis deadline teardown to settle",
          );
        } finally {
          if (previousPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = previousPath;
          }
          killKnownProcessPids([parentPid, descendantPid]);
        }
      }
    },
    15_000,
  );
});
