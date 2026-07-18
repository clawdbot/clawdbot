// Run Additional Boundary Checks tests cover run additional boundary checks script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOUNDARY_CHECKS,
  createBoundedOutputBuffer,
  formatCommand,
  parseCliArgs,
  parseShardSelection,
  parseShardSpec,
  resolveConcurrency,
  resolvePositiveInteger,
  runChecks,
  runSingleCheck,
  selectChecksForShard,
} from "../../scripts/run-additional-boundary-checks.mjs";

function createOutputBuffer() {
  const chunks: string[] = [];
  return {
    output: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(""),
  };
}

function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["scripts/run-additional-boundary-checks.mjs", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessZombie(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim().startsWith("Z");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`process still alive: ${pid}`);
}

async function waitForNotRunning(pid: number, timeoutMs: number): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessAlive(pid) || isProcessZombie(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`process still running: ${pid}`);
}

async function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("child did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe("run-additional-boundary-checks", () => {
  it("keeps prompt snapshot drift checks in their dedicated CI lane", () => {
    // The snapshot check regenerates prompt fixtures over the full agent
    // tool/prompt import graph; packing it into a boundary shard makes that
    // shard the PR wall clock, so it owns the check-prompt-snapshots lane.
    expect(BOUNDARY_CHECKS.some((check) => check.label === "prompt:snapshots:check")).toBe(false);
    const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("check_name: check-prompt-snapshots");
    expect(workflow).toContain('run_check "prompt:snapshots:check" pnpm prompt:snapshots:check');
  });

  it("normalizes concurrency input", () => {
    expect(resolveConcurrency("6")).toBe(6);
    expect(resolveConcurrency(undefined, 2)).toBe(2);
    expect(() => resolveConcurrency("0")).toThrow("concurrency must be a positive integer; got: 0");
    expect(() => resolveConcurrency("6x", 2)).toThrow(
      "concurrency must be a positive integer; got: 6x",
    );
  });

  it("rejects malformed timeout and output limit integers", () => {
    expect(resolvePositiveInteger("25", 50, "OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS")).toBe(25);
    expect(resolvePositiveInteger(undefined, 50, "OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS")).toBe(
      50,
    );
    expect(() =>
      resolvePositiveInteger("1000ms", 50, "OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS"),
    ).toThrow("OPENCLAW_ADDITIONAL_BOUNDARY_TIMEOUT_MS must be a positive integer; got: 1000ms");
    expect(() =>
      resolvePositiveInteger("1e3", 50, "OPENCLAW_ADDITIONAL_BOUNDARY_OUTPUT_MAX_BYTES"),
    ).toThrow("OPENCLAW_ADDITIONAL_BOUNDARY_OUTPUT_MAX_BYTES must be a positive integer; got: 1e3");
  });

  it("formats command display text", () => {
    expect(formatCommand({ command: "pnpm", args: ["run", "lint:core"] })).toBe(
      "pnpm run lint:core",
    );
  });

  it("keeps only a bounded tail of command output", () => {
    const output = createBoundedOutputBuffer(12);
    output.append("first-line\n");
    output.append("second-line\n");

    expect(output.read()).toBe("[output truncated to last 12 bytes]\nsecond-line\n");
  });

  it("drops split UTF-8 prefixes when one chunk exceeds the output byte cap", () => {
    const output = createBoundedOutputBuffer(5);
    output.append("old😀new");

    expect(output.read()).toBe("[output truncated to last 5 bytes]\nnew");
  });

  it("drops split UTF-8 prefixes when older buffered output overflows", () => {
    const output = createBoundedOutputBuffer(5);
    output.append("old😀");
    output.append("new");

    expect(output.read()).toBe("[output truncated to last 5 bytes]\nnew");
  });

  it("parses and applies CI shard specs", () => {
    expect(parseShardSpec("2/4")).toEqual({ count: 4, index: 1, label: "2/4" });
    expect(parseShardSelection("2/4,3/4")).toEqual([
      { count: 4, index: 1, label: "2/4" },
      { count: 4, index: 2, label: "3/4" },
    ]);
    expect(selectChecksForShard(BOUNDARY_CHECKS, "1/4")).toEqual(
      BOUNDARY_CHECKS.filter((_check, index) => index % 4 === 0),
    );
    expect(selectChecksForShard(BOUNDARY_CHECKS, "2/4,3/4")).toEqual(
      BOUNDARY_CHECKS.filter((_check, index) => index % 4 === 1 || index % 4 === 2),
    );
    const shardedLabels = [1, 2, 3, 4].flatMap((index) =>
      selectChecksForShard(BOUNDARY_CHECKS, `${index}/4`).map((check) => check.label),
    );
    expect(shardedLabels.toSorted((a, b) => a.localeCompare(b))).toEqual(
      BOUNDARY_CHECKS.map((check) => check.label).toSorted((a, b) => a.localeCompare(b)),
    );
    expect(new Set(shardedLabels).size).toBe(BOUNDARY_CHECKS.length);
    expect(() => parseShardSpec("5/4")).toThrow("Invalid shard spec");
    expect(() => parseShardSpec("9007199254740993/9007199254740994")).toThrow("Invalid shard spec");
  });

  it("parses CLI help and shard args before running checks", () => {
    expect(parseCliArgs(["--help"], {})).toEqual({ help: true, shardSpec: "" });
    expect(parseCliArgs(["--shard", "2/4"], {})).toEqual({ help: false, shardSpec: "2/4" });
    expect(parseCliArgs(["--shard=3/4"], {})).toEqual({ help: false, shardSpec: "3/4" });
    expect(parseCliArgs([], { OPENCLAW_ADDITIONAL_BOUNDARY_SHARD: "4/4" })).toEqual({
      help: false,
      shardSpec: "4/4",
    });
    expect(() => parseCliArgs(["--shard"], {})).toThrow("--shard requires a value");
    expect(() => parseCliArgs(["--shard", "-h"], {})).toThrow("--shard requires a value");
    expect(() => parseCliArgs(["--wat"], {})).toThrow("Unknown argument: --wat");
  });

  it("does not start checks for CLI help or invalid arguments", () => {
    const help = runCli("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: node scripts/run-additional-boundary-checks.mjs");
    expect(help.stdout).not.toContain("::group::");
    expect(help.stderr).toBe("");

    const unknown = runCli("--wat");
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown argument: --wat");
    expect(unknown.stderr).toContain("Usage: node scripts/run-additional-boundary-checks.mjs");
    expect(unknown.stderr).not.toContain("::group::");
    expect(unknown.stderr).not.toContain("pnpm");
  });

  it("keeps the raw HTTP/2 import guard in source boundary checks", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "lint:tmp:no-raw-http2-imports",
      command: "pnpm",
      args: ["run", "lint:tmp:no-raw-http2-imports"],
    });
  });

  it("keeps the Docker E2E package guard in CI boundary checks", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "lint:docker-e2e",
      command: "pnpm",
      args: ["run", "lint:docker-e2e"],
    });
  });

  it("keeps the Telegram grammY type import guard in source boundary checks", () => {
    expect(BOUNDARY_CHECKS).toContainEqual({
      label: "lint:extensions:telegram-grammy-types",
      command: "pnpm",
      args: ["run", "lint:extensions:telegram-grammy-types"],
    });
  });

  it("buffers grouped output and reports aggregate failures", async () => {
    const buffer = createOutputBuffer();
    const failures = await runChecks(
      [
        {
          label: "passes",
          command: process.execPath,
          args: ["-e", "console.log('ok-out')"],
        },
        {
          label: "fails",
          command: process.execPath,
          args: ["-e", "console.error('bad-out'); process.exit(7)"],
        },
      ],
      { concurrency: 2, output: buffer.output },
    );

    const text = buffer.text();
    expect(failures).toBe(1);
    expect(text).toContain("::group::passes");
    expect(text).toContain("ok-out");
    expect(text).toContain("[ok] passes in ");
    expect(text).toContain("::group::fails");
    expect(text).toContain("bad-out");
    expect(text).toContain("::error title=fails failed::fails failed (exit 7)");
    expect(text).toContain("Additional boundary check timings:");
  });

  it("times out hung checks", async () => {
    const result = await runSingleCheck(
      {
        label: "hangs",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
      {
        checkTimeoutMs: 50,
        cwd: process.cwd(),
        env: process.env,
        outputMaxBytes: 4096,
      },
    );

    expect(result.code).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("timed out after 50ms");
  });

  it("preserves UTF-8 split across process output chunks before trimming the byte tail", async () => {
    const script = [
      'const bytes = Buffer.from("old😀new");',
      "process.stdout.write(bytes.subarray(0, 5));",
      "setTimeout(() => process.stdout.end(bytes.subarray(5)), 20);",
    ].join("");
    const result = await runSingleCheck(
      {
        label: "split-utf8",
        command: process.execPath,
        args: ["-e", script],
      },
      {
        checkTimeoutMs: 2_000,
        cwd: process.cwd(),
        env: process.env,
        outputMaxBytes: 5,
      },
    );

    expect(result.code).toBe(0);
    expect(result.output).toBe("[output truncated to last 5 bytes]\nnew");
  });

  it("clamps oversized check timers before scheduling", async () => {
    const result = await runSingleCheck(
      {
        label: "slow-pass",
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 25)"],
      },
      {
        checkTimeoutMs: Number.MAX_SAFE_INTEGER,
        cwd: process.cwd(),
        env: process.env,
        outputMaxBytes: 4096,
      },
    );

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "waits for timed-out process groups after the wrapper exits",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-timeout-"));
      const childPidPath = path.join(tempDir, "child.pid");
      let childPid: number | undefined;
      try {
        const childScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join("");

        const resultPromise = runSingleCheck(
          {
            label: "wrapper-exits",
            command: process.execPath,
            args: ["-e", parentScript],
          },
          {
            checkTimeoutMs: 100,
            cwd: process.cwd(),
            env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            outputMaxBytes: 4096,
          },
        );

        await waitForFile(childPidPath, 2000);
        childPid = Number(fs.readFileSync(childPidPath, "utf8"));
        const result = await resultPromise;

        expect(result.code).toBe(1);
        expect(result.timedOut).toBe(true);
        await waitForDead(childPid, 2000);
      } finally {
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans active check descendants on parent signal",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-boundary-signal-"));
      const readyPath = path.join(tempDir, "ready");
      const childPidPath = path.join(tempDir, "child.pid");
      let childPid: number | undefined;
      let runner: ReturnType<typeof spawn> | undefined;
      try {
        const childScript = [
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const fs = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
          "fs.writeFileSync(process.env.OPENCLAW_TEST_READY, 'ready');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");
        const runnerScript = `
import { runChecks } from ${JSON.stringify(
          new URL("../../scripts/run-additional-boundary-checks.mjs", import.meta.url).href,
        )};

await runChecks(
  [{
    label: "parent-signal",
    command: process.execPath,
    args: ["-e", ${JSON.stringify(parentScript)}],
  }],
  {
    checkTimeoutMs: 30000,
    concurrency: 1,
    cwd: process.cwd(),
    env: process.env,
    output: { write() { return true; } },
    outputMaxBytes: 4096,
  },
);
`;

        runner = spawn(process.execPath, ["--input-type=module", "--eval", runnerScript], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPENCLAW_TEST_CHILD_PID: childPidPath,
            OPENCLAW_TEST_READY: readyPath,
          },
          stdio: ["ignore", "ignore", "pipe"],
        });

        await waitForFile(readyPath, 2000);
        childPid = Number(fs.readFileSync(childPidPath, "utf8"));
        expect(Number.isInteger(childPid)).toBe(true);
        expect(isProcessAlive(childPid)).toBe(true);

        runner.kill("SIGTERM");
        await sleep(50);
        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner, 10_000)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForNotRunning(childPid, 2000);
      } finally {
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );
});
