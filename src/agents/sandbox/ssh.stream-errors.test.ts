import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const tempDirs: string[] = [];

let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ uploadDirectoryToSshTarget } = await import("./ssh.js"));
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

function fakeSession(): import("./ssh.js").SshSandboxSession {
  return {
    command: "ssh",
    configPath: "/tmp/ssh-config",
    host: "host",
  };
}

describe("SSH sandbox stream errors", () => {
  it.each(["tar.stdout", "tar.stderr", "ssh.stdin", "ssh.stdout", "ssh.stderr"] as const)(
    "rejects and terminates both upload children once when %s fails",
    async (stream) => {
      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-stream-test-"));
      tempDirs.push(localDir);
      const tar = createMockChildProcess();
      const ssh = createMockChildProcess();
      spawnMock
        .mockReturnValueOnce(tar as unknown as ChildProcess)
        .mockReturnValueOnce(ssh as unknown as ChildProcess);
      const expected = `${stream} failed`;
      const result = uploadDirectoryToSshTarget({
        session: fakeSession(),
        localDir,
        remoteDir: "/remote/workspace",
      });
      const rejection = result.then(
        () => {
          throw new Error(`expected rejection: ${expected}`);
        },
        (error: unknown) => {
          expect(error).toEqual(expect.objectContaining({ message: expected }));
        },
      );
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2), { timeout: 10_000 });
      const [childName, streamName] = stream.split(".") as ["tar" | "ssh", keyof MockChildProcess];
      const failedStream = { tar, ssh }[childName][streamName] as PassThrough;

      failedStream.emit("error", new Error(expected));

      await rejection;
      expect(tar.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(ssh.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");

      tar.emit("close", 0);
      ssh.emit("close", 0);
      failedStream.emit("error", new Error("late stream error"));
      expect(tar.kill).toHaveBeenCalledOnce();
      expect(ssh.kill).toHaveBeenCalledOnce();
    },
  );
});
