// Spawn utility tests cover child process setup and stream handling helpers.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { spawnWithFallback } from "./spawn-utils.js";

function createStubChild() {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: 1234, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  child.kill = vi.fn(() => true) as ChildProcess["kill"];
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

function spawnOptionsAt(
  spawnMock: { mock: { calls: readonly unknown[][] } },
  callIndex: number,
): { stdio?: unknown } {
  const call = spawnMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected spawn call ${callIndex}`);
  }
  const options = call[2];
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error(`expected spawn call ${callIndex} options`);
  }
  return options;
}

describe("spawnWithFallback", () => {
  it("does not retry a failed spawn after its caller authority expires", async () => {
    const child = new EventEmitter() as ChildProcess;
    const spawnMock = vi.fn(() => child);
    let current = true;
    const pending = spawnWithFallback({
      argv: ["agent-cli"],
      options: {},
      fallbacks: [{ label: "no-detach", options: { detached: false } }],
      spawnImpl: spawnMock,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Completion authority expired");
        }
      },
    });
    const rejected = expect(pending).rejects.toThrow("Completion authority expired");
    current = false;
    child.emit("error", Object.assign(new Error("spawn EBADF"), { code: "EBADF" }));

    await rejected;
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("retries on EBADF using fallback options", async () => {
    const spawnMock = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = new Error("spawn EBADF");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      })
      .mockImplementationOnce(() => createStubChild());

    const result = await spawnWithFallback({
      argv: ["echo", "ok"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
      spawnImpl: spawnMock,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.fallbackLabel).toBe("safe-stdin");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnOptionsAt(spawnMock, 0).stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawnOptionsAt(spawnMock, 1).stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("does not retry on non-EBADF errors", async () => {
    const spawnMock = vi.fn().mockImplementationOnce(() => {
      const err = new Error("spawn ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    await expect(
      spawnWithFallback({
        argv: ["missing"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
        fallbacks: [{ label: "safe-stdin", options: { stdio: ["ignore", "pipe", "pipe"] } }],
        spawnImpl: spawnMock,
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not spawn a fallback after request authority retires during startup", async () => {
    let current = true;
    const retired = Object.assign(new Error("request authority retired"), { code: "EBADF" });
    const firstChild = createStubChild();
    Object.defineProperty(firstChild, "pid", { value: undefined });
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockImplementation(() => createStubChild());
    const onFallback = vi.fn();
    const run = spawnWithFallback({
      argv: ["agent-cli"],
      options: {},
      fallbacks: [
        { label: "no-detach", options: { detached: false } },
        { label: "ignore-stdin", options: { stdio: "ignore" } },
      ],
      spawnImpl: spawnMock,
      onFallback,
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    });
    const outcome = Promise.allSettled([run]);
    current = false;
    firstChild.emit("error", Object.assign(new Error("spawn EBADF"), { code: "EBADF" }));

    expect(await outcome).toEqual([{ status: "rejected", reason: retired }]);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledOnce();
  });
});
