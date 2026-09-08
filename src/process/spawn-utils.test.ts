import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { spawnWithFallback } from "./spawn-utils.js";

type SpawnImplementation = NonNullable<Parameters<typeof spawnWithFallback>[0]["spawnImpl"]>;

function createStubChild() {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

describe("spawnWithFallback", () => {
  it("retries on EBADF using fallback options", async () => {
    const spawnMock = vi
      .fn<SpawnImplementation>()
      .mockImplementationOnce(() => {
        const err = new Error("spawn EBADF");
        (err as NodeJS.ErrnoException).code = "EBADF";
        throw err;
      })
      .mockImplementationOnce(() => createStubChild());

    const result = await spawnWithFallback({
      argv: ["echo", "ok"],
      options: { stdio: ["pipe", "pipe", "pipe"] },
      fallbacks: [{ stdio: ["ignore", "pipe", "pipe"] }],
      spawnImpl: spawnMock,
    });

    expect(result.usedFallback).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]?.[2].stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(spawnMock.mock.calls[1]?.[2].stdio).toEqual(["ignore", "pipe", "pipe"]);
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
        fallbacks: [{ stdio: ["ignore", "pipe", "pipe"] }],
        spawnImpl: spawnMock,
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not spawn a fallback after request authority retires during startup", async () => {
    let current = true;
    const retired = Object.assign(new Error("request authority retired"), { code: "EBADF" });
    const firstChild = createStubChild();
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockImplementation(() => createStubChild());
    const run = spawnWithFallback({
      argv: ["agent-cli"],
      options: {},
      fallbacks: [{ detached: false }, { stdio: "ignore" }],
      spawnImpl: spawnMock,
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
  });

  it("rejects ENOENT from a real missing executable", async () => {
    await withTempDir("openclaw-spawn-missing-", async (dir) => {
      await expect(
        spawnWithFallback({
          argv: [path.join(dir, "missing-executable")],
          options: { stdio: "ignore" },
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
