// Memory Host SDK tests cover qmd process behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../../gateway-client/src/timeouts.js";

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  };
});

import {
  checkQmdBinaryAvailability,
  resolveCliSpawnInvocation,
  resolveQmdBinaryUnavailableReason,
  runCliCommand,
  type QmdBinaryAvailability,
} from "./qmd-process.js";

function createMockChild(params: { pid?: number } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
    closeWith: (code?: number | null, signal?: NodeJS.Signals | null) => void;
  };
  child.pid = params.pid;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.kill = vi.fn();
  child.closeWith = (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
    child.emit("close", code, signal);
  };
  return child;
}

let fixtureRoot = "";
let tempDir = "";
let platformSpy: MockInstance<() => NodeJS.Platform> | null = null;
let fixtureId = 0;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
const originalSystemRoot = process.env.SystemRoot;
const originalWindir = process.env.WINDIR;
const taskkillPath = path.win32.join("C:\\Windows", "System32", "taskkill.exe");

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-win-spawn-"));
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

afterAll(async () => {
  platformSpy?.mockRestore();
  platformSpy = null;
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  tempDir = path.join(fixtureRoot, `case-${fixtureId++}`);
  await fs.mkdir(tempDir, { recursive: true });
  process.env.SystemRoot = "C:\\Windows";
  delete process.env.WINDIR;
});

afterEach(() => {
  vi.useRealTimers();
  process.env.PATH = originalPath;
  process.env.PATHEXT = originalPathExt;
  restoreEnvValue("SystemRoot", originalSystemRoot);
  restoreEnvValue("WINDIR", originalWindir);
  platformSpy?.mockReturnValue("win32");
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 });
  tempDir = "";
});

describe("resolveCliSpawnInvocation", () => {
  it("unwraps npm cmd shims to a direct node entrypoint", async () => {
    const binDir = path.join(tempDir, "node_modules", ".bin");
    const packageDir = path.join(tempDir, "node_modules", "qmd");
    const scriptPath = path.join(packageDir, "dist", "cli.js");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\n", "utf8");
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
      "utf8",
    );
    await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.argv).toEqual([scriptPath, "query", "hello"]);
    expect(invocation.shell).not.toBe(true);
    expect(invocation.windowsHide).toBe(true);
  });

  it("fails closed when a Windows cmd shim cannot be resolved without shell execution", async () => {
    const binDir = path.join(tempDir, "bad-bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "qmd.cmd"), "@echo off\r\nREM no entrypoint\r\n", "utf8");

    process.env.PATH = `${binDir};${originalPath ?? ""}`;
    process.env.PATHEXT = ".CMD;.EXE";

    expect(() =>
      resolveCliSpawnInvocation({
        command: "qmd",
        args: ["query", "hello"],
        env: process.env,
        packageName: "qmd",
      }),
    ).toThrow(/without shell execution/);
  });

  it("keeps bare commands bare when no Windows wrapper exists on PATH", () => {
    process.env.PATH = originalPath ?? "";
    process.env.PATHEXT = ".CMD;.EXE";

    const invocation = resolveCliSpawnInvocation({
      command: "qmd",
      args: ["query", "hello"],
      env: process.env,
      packageName: "qmd",
    });

    expect(invocation.command).toBe("qmd");
    expect(invocation.argv).toEqual(["query", "hello"]);
    expect(invocation.shell).not.toBe(true);
  });
});

describe("checkQmdBinaryAvailability", () => {
  it("keeps legacy unavailable probe results source-compatible", () => {
    const legacyUnavailable: QmdBinaryAvailability = {
      available: false,
      error: "spawn qmd ENOENT",
    };

    expect(resolveQmdBinaryUnavailableReason(legacyUnavailable)).toBe("binary");
  });

  it("returns available when the qmd process spawns successfully", async () => {
    const child = createMockChild({ pid: 12344 });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: true });
    expect(spawnSyncMock).toHaveBeenCalledWith(taskkillPath, ["/PID", String(child.pid), "/T"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-kills Windows availability probes when graceful taskkill fails", async () => {
    const child = createMockChild({ pid: 12345 });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: true });

    expect(spawnSyncMock).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(spawnSyncMock).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("returns unavailable when the qmd process cannot be spawned", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, reason: "binary", error: "spawn qmd ENOENT" });
  });

  it("returns an explicit workspace error when cwd is missing", async () => {
    const missingDir = path.join(tempDir, "missing-workspace");

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: missingDir }),
    ).resolves.toEqual({
      available: false,
      reason: "workspace-cwd",
      error: `workspace directory missing: ${missingDir}`,
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not treat close-before-spawn as a successful availability probe", async () => {
    const child = createMockChild();
    const err = Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("close"));
      queueMicrotask(() => child.emit("error", err));
      return child;
    });

    await expect(
      checkQmdBinaryAvailability({ command: "qmd", env: process.env, cwd: tempDir }),
    ).resolves.toEqual({ available: false, reason: "binary", error: "spawn qmd ENOENT" });
  });

  it("caps oversized availability probe timeouts before scheduling", async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    spawnMock.mockReturnValueOnce(child);

    void checkQmdBinaryAvailability({
      command: "qmd",
      env: process.env,
      cwd: tempDir,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
  });
  it("kills timed-out availability probes by process group on POSIX", async () => {
    platformSpy?.mockReturnValue("linux");
    const killProcess = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = createMockChild({ pid: 4321 });
    spawnMock.mockReturnValueOnce(child);

    try {
      await expect(
        checkQmdBinaryAvailability({
          command: "qmd",
          env: process.env,
          cwd: tempDir,
          timeoutMs: 1,
        }),
      ).resolves.toEqual({
        available: false,
        reason: "binary",
        error: "spawn qmd timed out after 1ms",
      });

      expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ detached: true });
      expect(killProcess).toHaveBeenCalledWith(-4321, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      killProcess.mockRestore();
    }
  });
});

describe("runCliCommand", () => {
  it("keeps stdout and stderr on non-zero exits", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", '[{"docid":"abc","score":0.93}]');
        child.stderr.emit("data", "ggml-metal-device.m:612");
        child.closeWith(134);
      });
      return child;
    });

    try {
      await runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
      });
      throw new Error("expected runCliCommand to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      if (!(err instanceof Error)) {
        throw err;
      }
      expect(err.name).toBe("CliCommandError");
      expect(err).toMatchObject({
        code: 134,
        signal: null,
        stdout: '[{"docid":"abc","score":0.93}]',
        stderr: "ggml-metal-device.m:612",
      });
      expect(err.message).toContain("qmd query test failed (code 134)");
      expect(child.stdout.setEncoding).toHaveBeenCalledWith("utf8");
      expect(child.stderr.setEncoding).toHaveBeenCalledWith("utf8");
    }
  });

  it("records signal-only command failures", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", "[]");
        child.closeWith(null, "SIGABRT");
      });
      return child;
    });

    await expect(
      runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
      }),
    ).rejects.toMatchObject({
      code: null,
      signal: "SIGABRT",
      stdout: "[]",
    });
  });

  it("does not expose truncated output as a recoverable command failure", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", "too much output");
        child.closeWith(1);
      });
      return child;
    });

    await expect(
      runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 4,
      }),
    ).rejects.toThrow(/produced too much output/);
  });

  it("counts surrogate pairs as one character when capping failed command output", async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", "a🙂");
        child.closeWith(1);
      });
      return child;
    });

    await expect(
      runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 2,
      }),
    ).rejects.toThrow(/🙂/);
  });

  it("caps oversized command timeouts before scheduling", async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    spawnMock.mockReturnValueOnce(child);

    void runCliCommand({
      commandSummary: "qmd query test",
      spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
      env: process.env,
      cwd: tempDir,
      maxOutputChars: 10_000,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    }).catch(() => undefined);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("kills aborted cli command process groups on POSIX and rejects with the abort reason", async () => {
    platformSpy?.mockReturnValue("linux");
    const killProcess = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = createMockChild({ pid: 7654 });
    spawnMock.mockReturnValueOnce(child);
    const controller = new AbortController();

    try {
      const pending = runCliCommand({
        commandSummary: "qmd query slow",
        spawnInvocation: { command: "qmd", argv: ["query", "slow", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
        timeoutMs: 60_000,
        signal: controller.signal,
      });

      controller.abort(new Error("memory_search timed out after 15s"));

      await expect(pending).rejects.toThrow("memory_search timed out after 15s");
      expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ detached: true });
      expect(killProcess).toHaveBeenCalledWith(-7654, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      killProcess.mockRestore();
    }
  });

  it("rejects immediately without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("memory_search timed out after 15s"));

    await expect(
      runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("memory_search timed out after 15s");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("kills timed-out cli command process groups on POSIX", async () => {
    platformSpy?.mockReturnValue("linux");
    const killProcess = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = createMockChild({ pid: 8765 });
    spawnMock.mockReturnValueOnce(child);

    try {
      const pending = runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
        timeoutMs: 1,
      });
      const timeoutAssertion = expect(pending).rejects.toThrow(
        "qmd query test timed out after 1ms",
      );

      await timeoutAssertion;

      expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ detached: true });
      expect(killProcess).toHaveBeenCalledWith(-8765, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      killProcess.mockRestore();
    }
  });

  it("force-kills timed-out Windows cli commands with taskkill", async () => {
    const child = createMockChild({ pid: 12346 });
    spawnMock.mockReturnValueOnce(child);

    const pending = runCliCommand({
      commandSummary: "qmd query test",
      spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
      env: process.env,
      cwd: tempDir,
      maxOutputChars: 10_000,
      timeoutMs: 1,
    });

    await expect(pending).rejects.toThrow("qmd query test timed out after 1ms");

    expect(spawnSyncMock).toHaveBeenCalledWith(taskkillPath, ["/PID", "12346", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects when %s stream emits an error",
    async (streamName) => {
      const child = createMockChild();
      spawnMock.mockReturnValueOnce(child);
      const streamError = new Error(`${streamName} EPIPE`);

      const pending = runCliCommand({
        commandSummary: "qmd query test",
        spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
        env: process.env,
        cwd: tempDir,
        maxOutputChars: 10_000,
      });

      child[streamName].emit("error", streamError);

      await expect(pending).rejects.toMatchObject({
        message: `qmd query test ${streamName} error: ${streamName} EPIPE`,
        cause: streamError,
      });
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it("keeps the other stream guarded after stdout error", async () => {
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);

    const pending = runCliCommand({
      commandSummary: "qmd query test",
      spawnInvocation: { command: "qmd", argv: ["query", "test", "--json"] },
      env: process.env,
      cwd: tempDir,
      maxOutputChars: 10_000,
    });

    child.stdout.emit("error", new Error("stdout EPIPE"));

    expect(() => {
      child.stderr.emit("error", new Error("stderr later"));
    }).not.toThrow();

    await expect(pending).rejects.toThrow("qmd query test stdout error: stdout EPIPE");
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
