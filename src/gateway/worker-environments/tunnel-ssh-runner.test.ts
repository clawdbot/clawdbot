import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { createWorkerSshRunner, WORKER_TUNNEL_READY_MARKER } from "./tunnel-ssh-runner.js";

// Returned as the fake-typed union (not ChildProcessWithoutNullStreams) so `child.kill`
// stays a plain vi.fn property; casting to the real type makes kill an unbound method for lint.
function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: Mock<(signal?: NodeJS.Signals | number) => boolean>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  child.once("exit", (code, signal) => {
    let closed = false;
    const close = () => {
      if (!closed && child.stdout.closed && child.stderr.closed) {
        closed = true;
        child.emit("close", code, signal);
      }
    };
    child.stdout.once("close", close);
    child.stderr.once("close", close);
    close();
  });
  return child;
}

describe("worker SSH process runner", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles readiness and exit when spawn emits an error without close", async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const process = createWorkerSshRunner().start(["missing-ssh"], { timeoutMs: 10_000 });

    child.emit("error", new Error("spawn failed"));

    await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
    await expect(process.exited).resolves.toEqual({ code: null, signal: null });
  });

  it("settles with the real exit when close lags after SIGKILL", async () => {
    vi.useFakeTimers();
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const process = createWorkerSshRunner().start(["ssh"], { timeoutMs: 10_000 });

    const stopping = process.stop();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(stopping).resolves.toBeUndefined();
    await expect(process.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
  });

  it.each(["same turn", "after poll"])(
    "rejects a post-exit ready marker while retaining the final redacted diagnostic (%s)",
    async (delivery) => {
      const child = createChild();
      spawnMock.mockReturnValue(child);
      const process = createWorkerSshRunner().start(["ssh"], { timeoutMs: 10_000 });
      const bearer = "secret-credential-value";

      child.emit("exit", 255, null);
      if (delivery === "after poll") {
        await setImmediate();
      }
      child.stdout.write(`${WORKER_TUNNEL_READY_MARKER}\n`);
      child.stderr.write(`Authorization: Bearer ${bearer}\nconnection refused`);
      child.emit("close", 255, null);

      await expect(process.ready).rejects.toThrow("connection refused");
      const exit = await process.exited;
      expect(exit).toMatchObject({
        code: 255,
        signal: null,
        stderrTail: expect.stringContaining("connection refused"),
      });
      expect(exit.stderrTail).not.toContain(bearer);
    },
  );

  it("fails stop when a SIGKILLed child never reports exit", async () => {
    vi.useFakeTimers();
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const process = createWorkerSshRunner().start(["ssh"], { timeoutMs: 10_000 });

    const stopping = process.stop();
    const rejection = expect(stopping).rejects.toThrow("did not exit after SIGKILL");
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
  });

  it("treats a post-exit kill failure as terminal when close is delayed", async () => {
    vi.useFakeTimers();
    const child = createChild();
    child.kill = vi.fn(() => false);
    spawnMock.mockReturnValue(child);
    const process = createWorkerSshRunner().start(["ssh"], { timeoutMs: 10_000 });

    child.emit("exit", 255, null);
    const stopping = process.stop();
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(stopping).resolves.toBeUndefined();
    await expect(process.exited).resolves.toEqual({ code: 255, signal: null });
    await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
  });

  it("propagates a stop failure when SIGKILL delivery fails", async () => {
    vi.useFakeTimers();
    const child = createChild();
    child.kill = vi.fn(() => false);
    spawnMock.mockReturnValue(child);
    const process = createWorkerSshRunner().start(["ssh"], { timeoutMs: 10_000 });

    const stopping = process.stop();
    const rejection = expect(stopping).rejects.toThrow("SIGKILL delivery failed");
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;

    let exitedSettled = false;
    void process.exited.then(() => {
      exitedSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(exitedSettled).toBe(false);
  });

  it("keeps exited pending when a live child emits error without close", async () => {
    const child = createChild();
    (child as { pid?: number }).pid = 4242;
    spawnMock.mockReturnValue(child);
    const process = createWorkerSshRunner().start(["ssh"], { timeoutMs: 10_000 });

    child.emit("error", new Error("kill delivery failed"));

    await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
    let exitedSettled = false;
    void process.exited.then(() => {
      exitedSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(exitedSettled).toBe(false);

    child.emit("close", 0, null);
    await expect(process.exited).resolves.toEqual({ code: 0, signal: null });
  });

  it("retains a bounded redacted stderr tail after a ready child exits", async () => {
    const child = createChild();
    spawnMock.mockReturnValue(child);
    const process = createWorkerSshRunner().start(["ssh"], { timeoutMs: 10_000 });
    const bearer = "secret-credential-value";

    child.stdout.write(`${WORKER_TUNNEL_READY_MARKER}\n`);
    await process.ready;
    child.stderr.write(`Authorization: Bearer ${bearer}\n${"b".repeat(4_095)}😀`);
    child.emit("exit", 255, null);

    const exit = await process.exited;
    expect(exit).toMatchObject({ code: 255, signal: null });
    expect(exit.stderrTail).not.toContain(bearer);
    expect(exit.stderrTail?.length).toBeLessThanOrEqual(4_096);
    expect(exit.stderrTail?.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });

  it("passes the owner signal to spawn so abort terminates and settles the child", async () => {
    const child = createChild();
    spawnMock.mockImplementation((_command: string, _args: string[], options: SpawnOptions) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
          child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
      return child;
    });
    const controller = new AbortController();
    const process = createWorkerSshRunner().start(["ssh"], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(process.ready).rejects.toThrow("Worker SSH tunnel failed");
    await expect(process.exited).resolves.toEqual({ code: null, signal: null });
    expect(spawnMock).toHaveBeenCalledWith(
      "ssh",
      [],
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
