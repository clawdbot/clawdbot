import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "./invoke.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

function mockNextSpawn(child: MockChild): void {
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
}

describe("runCommand", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each(["stdout", "stderr"] as const)(
    "settles after child exit when %s emits an error",
    async (streamName) => {
      const child = createMockChild();
      mockNextSpawn(child);

      const resultPromise = testing.runCommand(["echo", "hello"], undefined, undefined, undefined);
      child.stdout.emit("data", Buffer.from("captured stdout"));
      child.stderr.emit("data", Buffer.from("captured stderr"));
      child[streamName].emit("error", new Error(`${streamName} broke`));

      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      child.stdout.emit("error", new Error("later stdout error"));
      child.stderr.emit("error", new Error("later stderr error"));
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit("exit", 1);

      await expect(resultPromise).resolves.toEqual({
        exitCode: 1,
        timedOut: false,
        success: false,
        stdout: "captured stdout",
        stderr: "captured stderr",
        error: `${streamName} broke`,
        truncated: false,
      });
    },
  );

  it("escalates stream-error termination when the child does not exit", async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    mockNextSpawn(child);

    const resultPromise = testing.runCommand(["slow"], undefined, undefined, undefined);
    child.stderr.emit("error", new Error("stderr broke"));

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(testing.STREAM_ERROR_KILL_GRACE_MS);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    child.emit("exit", null);
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: undefined,
      timedOut: false,
      success: false,
      error: "stderr broke",
    });
  });

  it("preserves child spawn errors", async () => {
    const child = createMockChild();
    mockNextSpawn(child);

    const resultPromise = testing.runCommand(["missing"], undefined, undefined, undefined);
    child.emit("error", new Error("spawn failed"));

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: undefined,
      timedOut: false,
      success: false,
      error: "spawn failed",
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("preserves timeout termination and exit settlement", async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    mockNextSpawn(child);

    const resultPromise = testing.runCommand(["slow"], undefined, undefined, 10);
    await vi.advanceTimersByTimeAsync(10);

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("exit", null);
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: undefined,
      timedOut: true,
      success: false,
      error: null,
    });
  });

  describe("working directory failures", () => {
    const enoent = (message: string) =>
      Object.assign(new Error(message), { code: "ENOENT" }) as NodeJS.ErrnoException;

    it("blames a missing working directory instead of the shell", () => {
      const cwd = path.join(os.tmpdir(), `node-exec-missing-${process.pid}-${Date.now()}`);
      expect(testing.clarifyNodeExecCwdSpawnError(enoent("spawn /bin/sh ENOENT"), cwd)).toBe(
        `node exec working directory does not exist on the node host: ${cwd} (os reported: spawn /bin/sh ENOENT)`,
      );
    });

    it("flags a cwd that exists but is not a directory", () => {
      const file = path.join(os.tmpdir(), `node-exec-file-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(file, "x");
      try {
        const error = Object.assign(new Error("spawn ENOTDIR"), {
          code: "ENOTDIR",
        }) as NodeJS.ErrnoException;
        expect(testing.clarifyNodeExecCwdSpawnError(error, file)).toBe(
          `node exec working directory is not a directory on the node host: ${file} (os reported: spawn ENOTDIR)`,
        );
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it("clarifies an asynchronous spawn error for a missing cwd", async () => {
      const child = createMockChild();
      mockNextSpawn(child);
      const cwd = path.join(os.tmpdir(), `node-exec-run-missing-${process.pid}-${Date.now()}`);

      const resultPromise = testing.runCommand(["/bin/sh"], cwd, undefined, undefined);
      child.emit("error", enoent("spawn /bin/sh ENOENT"));

      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining(
          `node exec working directory does not exist on the node host: ${cwd}`,
        ),
      });
    });

    it("clarifies a synchronous spawn throw for a cwd that is a file", async () => {
      const file = path.join(os.tmpdir(), `node-exec-run-file-${process.pid}-${Date.now()}.txt`);
      fs.writeFileSync(file, "x");
      vi.mocked(spawn).mockImplementationOnce(() => {
        throw Object.assign(new Error("spawn ENOTDIR"), { code: "ENOTDIR" });
      });
      try {
        await expect(
          testing.runCommand(["/bin/sh"], file, undefined, undefined),
        ).resolves.toMatchObject({
          success: false,
          error: expect.stringContaining(
            `node exec working directory is not a directory on the node host: ${file}`,
          ),
        });
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it("preserves genuine executable and unrelated spawn errors", () => {
      const missingExecutable = "spawn /usr/bin/does-not-exist ENOENT";
      expect(testing.clarifyNodeExecCwdSpawnError(enoent(missingExecutable), os.tmpdir())).toBe(
        missingExecutable,
      );
      expect(testing.clarifyNodeExecCwdSpawnError(enoent("spawn /bin/sh ENOENT"), undefined)).toBe(
        "spawn /bin/sh ENOENT",
      );
      const denied = Object.assign(new Error("spawn EACCES"), {
        code: "EACCES",
      }) as NodeJS.ErrnoException;
      expect(testing.clarifyNodeExecCwdSpawnError(denied, "/missing")).toBe("spawn EACCES");
    });

    it("preserves the spawn error when the cwd cannot be inspected", () => {
      const message = "spawn /bin/sh ENOENT";
      const stat = vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      });
      try {
        expect(testing.clarifyNodeExecCwdSpawnError(enoent(message), "/unreadable")).toBe(message);
      } finally {
        stat.mockRestore();
      }
    });
  });
});
