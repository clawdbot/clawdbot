import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  formatCliProcessFailure,
  runCliProcessChild,
  waitForCliProcessStderrMarker,
} from "./cli-process-child.test-helpers.js";

// A launcher that hands its stdio to a detached grandchild which writes only after the
// guard has already fired, then stays alive itself so SIGKILL has a launcher to reach.
const DETACHED_GRANDCHILD_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('after-guard'), 800); setInterval(() => {}, 1_000);\"],",
  "  { detached: true, stdio: ['ignore', 1, 2] }).unref();",
  "process.stdout.write('launcher');",
  "setInterval(() => {}, 1_000);",
].join("\n");

const sleep = async (ms: number) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe("formatCliProcessFailure", () => {
  it("includes the failure identity and both captured output tails", () => {
    const reason =
      "CLI process did not exit before the 240000ms deadlock guard (SIGKILL sent; exitCode=null signalCode=null)";
    const message = formatCliProcessFailure({
      reason,
      stderr: "startup trace: entry.bootstrap",
      stdout: "partial command output",
    });

    expect(message).toContain(reason);
    expect(message).toContain("startup trace: entry.bootstrap");
    expect(message).toContain("partial command output");
  });

  it("keeps the end of streams longer than the output tail cap", () => {
    const message = formatCliProcessFailure({
      reason: "wrong exit code",
      stderr: "",
      stdout: `${"x".repeat(8_005)}END`,
    });

    expect(message).toContain("[... truncated 8 chars ...]");
    expect(message).toMatch(/xEND$/u);
  });
});

describe("runCliProcessChild", () => {
  it("reports the child's exit code and both streams", async () => {
    const result = await runCliProcessChild({
      nodeArgs: [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);",
      ],
      env: process.env,
    });

    expect(result).toEqual({ code: 3, signal: null, stdout: "out", stderr: "err" });
  });

  it("names the deadlock guard and keeps partial output when a child never exits", async () => {
    await expect(
      runCliProcessChild({
        nodeArgs: ["-e", "process.stdout.write('partial'); setInterval(() => {}, 1_000);"],
        env: process.env,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/500ms deadlock guard[\s\S]*partial/u);
  });

  it("reaps the child and releases its pipes when interactive input fails", async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited: Promise<unknown> | undefined;
    try {
      await expect(
        runCliProcessChild({
          nodeArgs: ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1_000);"],
          env: process.env,
          interact: async (runningChild) => {
            child = runningChild;
            exited = once(runningChild, "exit");
            await once(runningChild.stdout, "data");
            throw new Error("interactive input failed");
          },
        }),
      ).rejects.toThrow("interactive input failed");

      expect(child?.killed).toBe(true);
      expect(child?.stdin.destroyed).toBe(true);
      expect(child?.stdout.destroyed).toBe(true);
      expect(child?.stderr.destroyed).toBe(true);
      await exited;
    } finally {
      child?.kill("SIGKILL");
      await exited;
    }
  });

  it("stops reading a detached grandchild's pipes once the guard fires", async () => {
    // The CLI's own respawn topology: stdio handed to a detached grandchild in its own
    // process group, which the launcher's SIGKILL cannot reach. If the guard rejects while
    // still holding those pipe ends, the orphan keeps feeding a Vitest worker that has
    // already moved on — the "still running with no output" stall this suite exists to kill.
    const chunks: string[] = [];

    await expect(
      runCliProcessChild({
        nodeArgs: ["-e", DETACHED_GRANDCHILD_SCRIPT],
        env: process.env,
        onStdout: (stdout) => chunks.push(stdout),
        timeoutMs: 400,
      }),
    ).rejects.toThrow(/400ms deadlock guard/u);

    const afterGuard = chunks.length;
    await sleep(900);

    expect(chunks).toHaveLength(afterGuard);
    expect(chunks.at(-1) ?? "").not.toContain("after-guard");
  });
});

describe("waitForCliProcessStderrMarker", () => {
  it("reports missing markers and captured stderr when the child exits", async () => {
    await expect(
      runCliProcessChild({
        nodeArgs: ["-e", "process.stderr.write('failed before ready'); process.exitCode = 1;"],
        env: process.env,
        timeoutMs: 2_000,
        interact: async (child) => {
          child.stdin.end();
          await waitForCliProcessStderrMarker(child, "phase entered");
        },
      }),
    ).rejects.toThrow(/stderr ended before marker "phase entered"[\s\S]*failed before ready/u);
  });

  it("matches split markers, removes its listeners, and retains trailing stderr", async () => {
    const result = await runCliProcessChild({
      nodeArgs: [
        "-e",
        [
          "process.stderr.write('phase ');",
          "process.stdin.once('data', () => {",
          "  process.stderr.write('entered');",
          "  process.stdin.once('end', () => process.stderr.write(' after marker'));",
          "});",
        ].join("\n"),
      ],
      env: process.env,
      interact: async (child) => {
        const events = ["data", "end", "close", "error"] as const;
        const listeners = events.map((event) => child.stderr.listeners(event));
        const childErrorListeners = child.listeners("error");
        const marker = waitForCliProcessStderrMarker(child, "phase entered");
        await once(child.stderr, "data");
        child.stdin.write("continue\n");
        await marker;
        for (const [index, event] of events.entries()) {
          expect(child.stderr.listeners(event)).toEqual(listeners[index]);
        }
        expect(child.listeners("error")).toEqual(childErrorListeners);
        expect(child.stderr.destroyed).toBe(false);
        child.stdin.end();
      },
    });

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "phase entered after marker",
    });
  });
});
