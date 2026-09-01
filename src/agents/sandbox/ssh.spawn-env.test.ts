// SSH spawn-env tests ensure subprocesses inherit only safe environment values
// while command execution and uploads run through ssh.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../../test-utils/env.js";
import { SANDBOX_COMMAND_MAX_BUFFER_BYTES } from "./constants.js";

const { spawnMock, spawnCommandMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnCommandMock: vi.fn(),
}));

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
  child.kill = vi.fn();
  return child;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  spawnCommand: spawnCommandMock,
}));

function mockSuccessfulSpawnCalls(times = 1) {
  let chain = spawnMock;
  for (let i = 0; i < times; i += 1) {
    chain = chain.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const child = createMockChildProcess();
        process.nextTick(() => {
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    );
  }
}

function spawnOptionsAt(index: number): SpawnOptions {
  // Secret filtering happens at the child_process.spawn boundary, so tests read
  // the captured SpawnOptions env directly.
  const options = spawnMock.mock.calls[index]?.[2] as SpawnOptions | undefined;
  if (!options) {
    throw new Error(`expected spawn options for call ${index}`);
  }
  return options;
}

function spawnCommandOptions(): {
  baseEnv: Record<string, string>;
  maxBuffer?: number;
} {
  const options = spawnCommandMock.mock.calls[0]?.[1] as
    | { baseEnv?: Record<string, string>; maxBuffer?: number }
    | undefined;
  if (!options?.baseEnv) {
    throw new Error("expected spawnCommand options");
  }
  return { ...options, baseEnv: options.baseEnv };
}

let runSshSandboxCommand: typeof import("./ssh.js").runSshSandboxCommand;
let prepareSshSandboxExec: typeof import("./ssh.js").prepareSshSandboxExec;
let uploadDirectoryToSshTarget: typeof import("./ssh.js").uploadDirectoryToSshTarget;

describe("ssh subprocess env sanitization", () => {
  const tempDirs: string[] = [];
  let envSnapshot: ReturnType<typeof captureFullEnv>;

  beforeEach(async () => {
    envSnapshot = captureFullEnv();
    vi.resetModules();
    vi.clearAllMocks();
    spawnCommandMock.mockResolvedValue({
      failed: false,
      isCanceled: false,
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    ({ prepareSshSandboxExec, runSshSandboxCommand, uploadDirectoryToSshTarget } =
      await import("./ssh.js"));
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
    envSnapshot.restore();
  });

  it("filters blocked secrets before spawning ssh commands", async () => {
    process.env.OPENAI_API_KEY = "x";
    process.env.LANG = "en_US.UTF-8";

    await runSshSandboxCommand({
      session: {
        command: "ssh",
        configPath: "/tmp/openclaw-test-ssh-config",
        host: "openclaw-sandbox",
      },
      remoteCommand: "true",
    });

    const options = spawnCommandOptions();
    const baseEnv = options.baseEnv;
    expect(baseEnv.OPENAI_API_KEY).toBeUndefined();
    expect(baseEnv.LANG).toBe("en_US.UTF-8");
    expect(options.maxBuffer).toBe(SANDBOX_COMMAND_MAX_BUFFER_BYTES);
  });

  it.each(["BAD-NAME", "1INVALID", "BAD\nNAME", " PADDED_NAME", "PADDED_NAME "])(
    "rejects invalid SSH environment name %j without exposing its value",
    async (name) => {
      const sentinel = "synthetic-invalid-name-value";
      await expect(
        prepareSshSandboxExec({
          session: {
            command: "ssh",
            configPath: "/tmp/openclaw-test-ssh-config",
            host: "openclaw-sandbox",
          },
          remoteCommand: "'/bin/sh' '-c' 'true'",
          env: { [name]: sentinel },
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain("POSIX variable name");
        expect(message).not.toContain(sentinel);
        return true;
      });
      expect(spawnCommandMock).not.toHaveBeenCalled();
    },
  );

  it("rejects NUL-containing SSH environment values before spawning without exposing them", async () => {
    const sentinel = "synthetic-private-value";
    await expect(
      prepareSshSandboxExec({
        session: {
          command: "ssh",
          configPath: "/tmp/openclaw-test-ssh-config",
          host: "openclaw-sandbox",
        },
        remoteCommand: "'/bin/sh' '-c' 'true'",
        env: { SYNTHETIC_VALUE: `${sentinel}\0suffix` },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("SYNTHETIC_VALUE");
      expect(message).toContain("NUL");
      expect(message).not.toContain(sentinel);
      return true;
    });
    expect(spawnCommandMock).not.toHaveBeenCalled();
  });

  it("preserves explicit TTY terminal values in staged stdin without SSH SetEnv", async () => {
    const sentinel = "synthetic-explicit-terminal";
    const prepared = await prepareSshSandboxExec({
      session: {
        command: "ssh",
        configPath: "/tmp/openclaw-test-ssh-config",
        host: "openclaw-sandbox",
      },
      remoteCommand: "'/bin/sh' '-c' 'printf %s \"$TERM\"'",
      env: { TERM: sentinel },
      tty: true,
    });

    const uploadArgv = spawnCommandMock.mock.calls[0]?.[0] as string[];
    const uploadOptions = spawnCommandMock.mock.calls[0]?.[1] as { input?: string };
    expect(uploadArgv).toContain("-T");
    expect(uploadArgv.join(" ")).not.toContain(sentinel);
    expect(uploadOptions.input).toContain(`export TERM='${sentinel}'`);
    expect(prepared.argv).toContain("-tt");
    expect(prepared.argv).toContain("RequestTTY=force");
    expect(prepared.argv.join(" ")).not.toContain(sentinel);
    expect(prepared.argv.join(" ")).not.toContain("SetEnv");

    await prepared.cleanup();
    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
  });

  it("removes remote SSH staging after an upload failure", async () => {
    const sentinel = "synthetic-failed-upload-value";
    spawnCommandMock.mockResolvedValueOnce({
      failed: false,
      isCanceled: false,
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("synthetic staging failure"),
    });

    await expect(
      prepareSshSandboxExec({
        session: {
          command: "ssh",
          configPath: "/tmp/openclaw-test-ssh-config",
          host: "openclaw-sandbox",
        },
        remoteCommand: "'/bin/sh' '-c' 'true'",
        env: { SYNTHETIC_VALUE: sentinel },
      }),
    ).rejects.toThrow("synthetic staging failure");

    expect(spawnCommandMock).toHaveBeenCalledTimes(2);
    const uploadArgv = spawnCommandMock.mock.calls[0]?.[0] as string[];
    const uploadOptions = spawnCommandMock.mock.calls[0]?.[1] as { input?: string };
    const cleanupArgv = spawnCommandMock.mock.calls[1]?.[0] as string[];
    expect(uploadArgv.join(" ")).not.toContain(sentinel);
    expect(uploadOptions.input).toContain(sentinel);
    expect(cleanupArgv.at(-1)).toContain("openclaw-sandbox-exec-cleanup");
    expect(cleanupArgv.join(" ")).not.toContain(sentinel);
  });

  it("rejects transport failures even when ssh exits zero", async () => {
    spawnCommandMock.mockResolvedValueOnce(
      Object.assign(new Error("ssh stream failed"), {
        failed: true,
        isCanceled: false,
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }),
    );

    await expect(
      runSshSandboxCommand({
        session: {
          command: "ssh",
          configPath: "/tmp/openclaw-test-ssh-config",
          host: "openclaw-sandbox",
        },
        remoteCommand: "true",
      }),
    ).rejects.toThrow("ssh stream failed");
  });

  it("rejects transport failures even when ssh exits nonzero", async () => {
    spawnCommandMock.mockResolvedValueOnce(
      Object.assign(new Error("ssh stream failed"), {
        cause: new Error("ssh stream failed"),
        failed: true,
        isCanceled: false,
        exitCode: 7,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }),
    );

    await expect(
      runSshSandboxCommand({
        session: {
          command: "ssh",
          configPath: "/tmp/openclaw-test-ssh-config",
          host: "openclaw-sandbox",
        },
        remoteCommand: "false",
        allowFailure: true,
      }),
    ).rejects.toThrow("ssh stream failed");
  });

  it("filters blocked secrets before spawning ssh uploads", async () => {
    mockSuccessfulSpawnCalls(2);

    process.env.ANTHROPIC_API_KEY = "x";
    process.env.NODE_ENV = "test";
    const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-env-"));
    tempDirs.push(localDir);

    await uploadDirectoryToSshTarget({
      session: {
        command: "ssh",
        configPath: "/tmp/openclaw-test-ssh-config",
        host: "openclaw-sandbox",
      },
      localDir,
      remoteDir: "/remote/workspace",
    });

    const env = spawnOptionsAt(1).env;
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env?.NODE_ENV).toBe("test");
  });

  it.runIf(process.platform !== "win32")(
    "allows in-workspace symlinks to upload normally",
    async () => {
      mockSuccessfulSpawnCalls(2);

      const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ssh-upload-safe-"));
      tempDirs.push(localDir);
      await fs.mkdir(path.join(localDir, "real"), { recursive: true });
      await fs.writeFile(path.join(localDir, "real", "payload.txt"), "ok\n", "utf8");
      await fs.symlink("real", path.join(localDir, "linked-dir"));

      await uploadDirectoryToSshTarget({
        session: {
          command: "ssh",
          configPath: "/tmp/openclaw-test-ssh-config",
          host: "openclaw-sandbox",
        },
        localDir,
        remoteDir: "/remote/workspace",
      });

      expect(spawnMock).toHaveBeenCalledTimes(2);
    },
  );
});
