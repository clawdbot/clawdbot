import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

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

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let localDir: string;

let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;

beforeAll(async () => {
  vi.resetModules();
  ({ uploadDirectoryToSshTarget } = await import("./ssh.js"));
  localDir = tempDirs.make("openclaw-ssh-stream-test-");
});

beforeEach(() => {
  spawnMock.mockReset();
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
      const tar = createMockChildProcess();
      const ssh = createMockChildProcess();
      const childrenSpawned = createDeferred();
      spawnMock.mockReturnValueOnce(tar as unknown as ChildProcess).mockImplementationOnce(() => {
        childrenSpawned.resolve();
        return ssh as unknown as ChildProcess;
      });
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
      await withTestTimeout(
        childrenSpawned.promise,
        10_000,
        "tar/ssh upload children did not spawn",
      );
      expect(spawnMock).toHaveBeenCalledTimes(2);
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
