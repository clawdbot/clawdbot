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

  it("drains active descendant output after the parent exits", async () => {
    const command = 'printf "HEAD\\n"; ( sleep 0.05; printf "TAIL\\n" ) &';
    child = execa("/bin/sh", ["-c", command], {
      buffer: false,
      detached: true,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const releaseOutput = releaseChildProcessOutputAfterExit(child);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    // Simulate a contended worker after the direct child exits. The descendant
    // writes while JS is parked, so its pipe data and the idle timer are both
    // ready when the event loop resumes.
    await new Promise<void>((resolve) => {
      child?.once("exit", () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        resolve();
      });
    });
    await child.finally(releaseOutput);
    expect(output).toContain("HEAD");
    expect(output).toContain("TAIL");
  });

  it("releases a quiet inherited pipe after the idle grace", async () => {
    child = execa("/bin/sh", ["-c", 'printf "DONE\\n"; ( sleep 30 ) &'], {
      buffer: false,
      detached: true,
      reject: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const releaseOutput = releaseChildProcessOutputAfterExit(child);
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

    await vi.advanceTimersByTimeAsync(999);
    expect(stdout.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.destroyed).toBe(true);

    clearInterval(writer);
    cleanup();
  });
});
