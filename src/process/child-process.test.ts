import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execa, type ResultPromise } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseChildProcessOutputAfterExit } from "./child-process.js";

describe.skipIf(process.platform === "win32")("releaseChildProcessOutputAfterExit", () => {
  let child: ResultPromise | undefined;

  afterEach(() => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    child = undefined;
    vi.useRealTimers();
  });

  it.each([250, 1_250])(
    "drains descendant output across a %ims event-loop stall",
    async (stallMs) => {
      const command =
        'printf "HEAD\\n"; printf "HEAD\\n" >&2; ( sleep 0.05; printf "TAIL\\n"; printf "TAIL\\n" >&2 ) &';
      child = execa("/bin/sh", ["-c", command], {
        detached: true,
        reject: false,
        stdio: ["ignore", "pipe", "pipe"],
        stripFinalNewline: false,
      });
      const releaseOutput = releaseChildProcessOutputAfterExit(child.nodeChildProcess);

      // Simulate a contended worker after the direct child exits. The descendant
      // writes while JS is parked past the idle or hard deadline, so buffered
      // pipe data and release timers are ready when the event loop resumes.
      await new Promise<void>((resolve) => {
        child?.nodeChildProcess.once("exit", () => {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
          resolve();
        });
      });
      expect(await child.finally(releaseOutput)).toMatchObject({
        exitCode: 0,
        stdout: "HEAD\nTAIL\n",
        stderr: "HEAD\nTAIL\n",
      });
    },
  );

  it("releases a quiet inherited pipe after the idle grace", async () => {
    child = execa("/bin/sh", ["-c", 'printf "DONE\\n"; ( sleep 30 ) &'], {
      buffer: false,
      detached: true,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const releaseOutput = releaseChildProcessOutputAfterExit(child.nodeChildProcess);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const startedAt = Date.now();
    await child.finally(releaseOutput);
    expect(output).toContain("DONE");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds draining from a continuously writing descendant", async () => {
    vi.useFakeTimers();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
    }) as unknown as ChildProcess;
    const cleanup = releaseChildProcessOutputAfterExit(fakeChild);
    fakeChild.emit("exit", 0);
    const writer = setInterval(() => stdout.write("TICK\n"), 30);

    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(stdout.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stdout.destroyed).toBe(false);
      stdout.write("AFTER DEADLINE\n");
      await vi.advanceTimersByTimeAsync(1);
      expect(stdout.destroyed).toBe(true);
      expect(stderr.destroyed).toBe(true);
    } finally {
      clearInterval(writer);
      cleanup();
    }
  });

  it.each(["idle", "hard"])("cancels pending %s release when cleaned up", async (deadline) => {
    vi.useFakeTimers();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
    }) as unknown as ChildProcess;
    const cleanup = releaseChildProcessOutputAfterExit(fakeChild);
    fakeChild.emit("exit", 0);
    const writer = deadline === "hard" ? setInterval(() => stdout.write("TICK\n"), 30) : undefined;

    await vi.advanceTimersByTimeAsync(deadline === "hard" ? 1_000 : 100);
    cleanup();
    clearInterval(writer);
    await vi.runAllTimersAsync();
    expect(stdout.destroyed).toBe(false);
    expect(stderr.destroyed).toBe(false);
  });
});
