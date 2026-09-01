import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import type { QaSuiteSummaryJson } from "./suite-summary.js";
import { runQaWindowsTaskkill } from "./windows-system-tools.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./suite-process-lifecycle.test-support.ts", import.meta.url),
);
const artifactsRoot = path.join(repoRoot, ".artifacts", "qa-e2e");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeChildren = new Set<ChildProcess>();

const PROCESS_LIFECYCLE_SCENARIO = "channel-chat-baseline";
// Suite execution contends with the surrounding extension shard; only the bounded
// post-summary close window is the lifecycle contract this regression enforces.
const SUITE_COMPLETION_TIMEOUT_MS = 420_000;
const POST_SUMMARY_EXIT_TIMEOUT_MS = 45_000;

function buildSuiteProcessEnv(outputDir: string) {
  const home = path.join(outputDir, "process-home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
    OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw", "openclaw.json"),
    OPENCLAW_QA_SUITE_PROGRESS: "1",
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  delete env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH;
  delete env.OPENCLAW_VITEST_FS_MODULE_CACHE_WRITER;
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.OPENCLAW_NODE_COMPILE_CACHE_WRITER;
  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }
  return env;
}

function forceStopProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    if (!runQaWindowsTaskkill({ pid: child.pid, signal: "SIGKILL" })) {
      child.kill("SIGKILL");
    }
    return;
  }
  const rows = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")
    .flatMap((line) => {
      const [pidText, parentPidText] = line.trim().split(/\s+/u);
      const pid = Number(pidText);
      const parentPid = Number(parentPidText);
      return Number.isSafeInteger(pid) && Number.isSafeInteger(parentPid)
        ? [{ pid, parentPid }]
        : [];
    });
  const owned = new Set([child.pid]);
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    for (const { pid, parentPid } of rows) {
      if (owned.has(parentPid) && !owned.has(pid)) {
        owned.add(pid);
        foundDescendant = true;
      }
    }
  }
  for (const pid of [...owned].toReversed()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

afterEach(async () => {
  for (const child of activeChildren) {
    forceStopProcessTree(child);
  }
  await Promise.all(
    [...activeChildren].map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
        }),
    ),
  );
  activeChildren.clear();
});

function startSuiteProcess(outputDir: string, scenarioIds: readonly string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixturePath, outputDir, ...scenarioIds],
    {
      cwd: repoRoot,
      env: buildSuiteProcessEnv(outputDir),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  activeChildren.add(child);
  let stdout = "";
  let stderr = "";
  const gatewayPorts = new Set<number>();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    for (const match of chunk.matchAll(/gateway ready: http:\/\/127\.0\.0\.1:(\d+)/gu)) {
      gatewayPorts.add(Number(match[1]));
    }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        activeChildren.delete(child);
        resolve({ code, signal });
      });
    },
  );
  return {
    child,
    closed,
    gatewayPorts,
    output: () => ({ stderr, stdout }),
  };
}

async function isTcpPortOpen(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForCompletedSummary(params: {
  outputDir: string;
  timeoutMs: number;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output: () => { stderr: string; stdout: string };
}) {
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  const deadline = Date.now() + params.timeoutMs;
  const processState: {
    error?: unknown;
    outcome?: { code: number | null; signal: NodeJS.Signals | null };
  } = {};
  void params.closed.then(
    (outcome) => {
      processState.outcome = outcome;
    },
    (error: unknown) => {
      processState.error = error;
    },
  );
  const throwIfProcessClosed = () => {
    if (!processState.error && !processState.outcome) {
      return;
    }
    const output = params.output();
    throw new Error(
      `QA suite process exited before writing a completed summary: ${JSON.stringify(processState.outcome ?? { error: String(processState.error) })}\nstdout:\n${output.stdout.slice(-8_000)}\nstderr:\n${output.stderr.slice(-8_000)}`,
    );
  };
  while (Date.now() < deadline) {
    let summary: QaSuiteSummaryJson;
    try {
      summary = JSON.parse(await fs.readFile(summaryPath, "utf8")) as QaSuiteSummaryJson;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      throwIfProcessClosed();
      await sleep(50);
      continue;
    }
    const runStatus: unknown = summary.run.status;
    if (runStatus === "completed") {
      return summary;
    }
    if (runStatus !== "running") {
      throw new Error(`QA suite summary is missing lifecycle status: ${String(runStatus)}`);
    }
    throwIfProcessClosed();
    await sleep(50);
  }
  const output = params.output();
  throw new Error(
    `QA suite did not write a completed summary within ${params.timeoutMs}ms\nstdout:\n${output.stdout.slice(-8_000)}\nstderr:\n${output.stderr.slice(-8_000)}`,
  );
}

async function waitForProcessClose(
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMs: number,
) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `QA suite process did not exit within ${timeoutMs}ms of summary completion`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe("qa suite command process lifecycle", () => {
  it(
    "exits after the terminal summary and leaves no gateway listener",
    { timeout: SUITE_COMPLETION_TIMEOUT_MS + POST_SUMMARY_EXIT_TIMEOUT_MS + 30_000 },
    async () => {
      await fs.mkdir(artifactsRoot, { recursive: true });
      const outputDir = tempDirs.make("suite-process-lifecycle-", artifactsRoot);
      const run = startSuiteProcess(outputDir, [PROCESS_LIFECYCLE_SCENARIO]);
      const startedWaitingAt = Date.now();
      const heartbeat = setInterval(() => {
        const output = run.output();
        process.stderr.write(
          `[qa-process-lifecycle] waiting for completed summary elapsedMs=${Date.now() - startedWaitingAt} gatewayPorts=${run.gatewayPorts.size} stderrBytes=${Buffer.byteLength(output.stderr)}\n`,
        );
      }, 30_000);
      heartbeat.unref();
      const summary = await waitForCompletedSummary({
        outputDir,
        timeoutMs: SUITE_COMPLETION_TIMEOUT_MS,
        closed: run.closed,
        output: run.output,
      }).finally(() => clearInterval(heartbeat));
      const outcome = await waitForProcessClose(run.closed, POST_SUMMARY_EXIT_TIMEOUT_MS);
      const output = run.output();

      expect(outcome, output.stderr).toEqual({ code: 0, signal: null });
      expect(run.gatewayPorts.size, output.stderr).toBeGreaterThan(0);
      expect(summary.run.status).toBe("completed");
      expect(summary.counts).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
      await expect(
        Promise.all([...run.gatewayPorts].map((port) => isTcpPortOpen(port))),
      ).resolves.toEqual([...run.gatewayPorts].map(() => false));
    },
  );
});
