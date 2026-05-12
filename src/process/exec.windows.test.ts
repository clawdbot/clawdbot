import type { execFile as execFileType } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetWindowsInstallRootsForTests,
  getWindowsInstallRoots,
} from "../infra/windows-install-roots.js";

const { spawnMock, spawnSyncMock, execFileMock, execFilePromisifyMock } = vi.hoisted(() => {
  const execFilePromisifyMock = vi.fn();
  const execFileMock = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: execFilePromisifyMock,
    __promisify__: execFilePromisifyMock,
  });
  return {
    spawnMock: vi.fn(),
    spawnSyncMock: vi.fn(),
    execFileMock,
    execFilePromisifyMock,
  };
});

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnMock,
      spawnSync: spawnSyncMock,
      execFile: execFileMock as unknown as typeof execFileType,
    },
  );
});

let runCommandWithTimeout: typeof import("./exec.js").runCommandWithTimeout;
let runExec: typeof import("./exec.js").runExec;

type MockChild = EventEmitter & {
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  killed?: boolean;
};

type SpawnCall = [string, string[], Record<string, unknown>];

function requireSpawnCall(callIndex: number): SpawnCall {
  const call = spawnMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected spawn call ${callIndex}`);
  }
  return call as SpawnCall;
}

function createMockChild(params?: {
  closeCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  exitCode?: number | null;
  exitCodeAfterClose?: number | null;
  exitCodeAfterCloseDelayMs?: number;
  signal?: NodeJS.Signals | null;
  autoClose?: boolean;
}): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = params?.exitCode ?? params?.closeCode ?? 0;
  child.signalCode = params?.signal ?? null;
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn(() => true);
  child.pid = 1234;
  child.killed = false;
  if (params?.autoClose !== false) {
    queueMicrotask(() => {
      child.emit("close", params?.closeCode ?? 0, params?.closeSignal ?? params?.signal ?? null);
      if (params?.exitCodeAfterClose !== undefined) {
        setTimeout(() => {
          child.exitCode = params.exitCodeAfterClose ?? null;
        }, params.exitCodeAfterCloseDelayMs ?? 0);
      }
    });
  }
  return child;
}

type ExecCall = [
  string,
  string[],
  Record<string, unknown>,
  (err: Error | null, stdout: string, stderr: string) => void,
];

function requireExecFileCall(callIndex: number): ExecCall {
  const call = execFileMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected execFile call ${callIndex}`);
  }
  return call as ExecCall;
}

function expectCmdWrappedInvocation(params: {
  captured: SpawnCall | ExecCall;
  expectedComSpec: string;
}) {
  expect(params.captured[0]).toBe(params.expectedComSpec);
  expect(params.captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(params.captured[1][3]).toContain("pnpm.cmd --version");
  expect(params.captured[2].windowsHide).toBe(true);
  expect(params.captured[2].windowsVerbatimArguments).toBe(true);
}

function expectedTrustedCmdExe(): string {
  return path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
}

async function expectShimmedWindowsCommandWithoutExitCodeSucceeds(params?: { killed?: boolean }) {
  const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const child = createMockChild({
    closeCode: null,
    exitCode: null,
  });
  child.killed = params?.killed ?? false;

  spawnMock.mockImplementation(() => child);

  try {
    const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.termination).toBe("exit");
  } finally {
    platformSpy.mockRestore();
  }
}

describe("windows command wrapper behavior", () => {
  beforeAll(async () => {
    ({ runCommandWithTimeout, runExec } = await import("./exec.js"));
  });

  beforeEach(() => {
    // Stub the registry probe so install-root resolution is fully driven by
    // process.env in tests; on real Windows runners the registry returns the
    // canonical SystemRoot and would shadow the test's env setup.
    _resetWindowsInstallRootsForTests({ queryRegistryValue: () => null });
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ stdout: "Active code page: 936", stderr: "" });
    execFileMock.mockReset();
    execFilePromisifyMock.mockReset();
    execFilePromisifyMock.mockImplementation(
      (command: string, args: string[], options: Record<string, unknown>) =>
        new Promise((resolve, reject) => {
          execFileMock(
            command,
            args,
            options,
            (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
              if (err) {
                reject(err);
                return;
              }
              resolve({ stdout, stderr });
            },
          );
        }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps .cmd commands via cmd.exe in runCommandWithTimeout", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedComSpec = expectedTrustedCmdExe();

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      const result = await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      const captured = requireSpawnCall(0);
      expectCmdWrappedInvocation({ captured, expectedComSpec });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("ignores ComSpec when selecting the Windows command wrapper", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousComSpec = process.env.ComSpec;
    const previousSystemRoot = process.env.SystemRoot;
    process.env.ComSpec = "C:\\workspace\\evil\\cmd.exe";
    process.env.SystemRoot = "C:\\Windows";

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      const result = await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      const captured = requireSpawnCall(0);
      expectCmdWrappedInvocation({
        captured,
        expectedComSpec: path.win32.join("C:\\Windows", "System32", "cmd.exe"),
      });
    } finally {
      if (previousComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = previousComSpec;
      }
      if (previousSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = previousSystemRoot;
      }
      platformSpy.mockRestore();
    }
  });

  it("rejects unsafe Windows root values when selecting the command wrapper", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      for (const unsafeRoot of [
        "\\\\evil\\share",
        "C:\\Windows;C:\\evil",
        "\\Windows",
        "relative\\path",
      ]) {
        _resetWindowsInstallRootsForTests({ queryRegistryValue: () => null });
        // Set every install-root env source to the unsafe value so the
        // resolver rejects each one and falls through to the safe default.
        // Deleting WINDIR here is unreliable on real Windows runners, so
        // overwrite it with the same rejected payload.
        process.env.SystemRoot = unsafeRoot;
        process.env.WINDIR = unsafeRoot;
        spawnMock.mockClear();

        const result = await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1000 });
        expect(result.code).toBe(0);
        const captured = requireSpawnCall(0);
        expectCmdWrappedInvocation({
          captured,
          expectedComSpec: path.win32.join("C:\\Windows", "System32", "cmd.exe"),
        });
      }
    } finally {
      if (previousSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = previousSystemRoot;
      }
      if (previousWindir === undefined) {
        delete process.env.WINDIR;
      } else {
        process.env.WINDIR = previousWindir;
      }
      platformSpy.mockRestore();
    }
  });

  it("wraps corepack.cmd via cmd.exe in runCommandWithTimeout", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedComSpec = expectedTrustedCmdExe();

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      const result = await runCommandWithTimeout(["corepack", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      const captured = requireSpawnCall(0);
      expect(captured[0]).toBe(expectedComSpec);
      expect(captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(captured[1][3]).toContain("corepack.cmd --version");
      expect(captured[2].windowsHide).toBe(true);
      expect(captured[2].windowsVerbatimArguments).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("keeps child exitCode when close reports null on Windows npm shims", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({ closeCode: null, exitCode: 0 });

    spawnMock.mockImplementation(() => child);

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("spawns node + npm-cli.js for npm argv to avoid direct .cmd execution", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const child = createMockChild({ closeCode: 0, exitCode: 0 });

    spawnMock.mockImplementation(() => child);

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      const captured = requireSpawnCall(0);
      expect(captured[0]).toBe(process.execPath);
      expect(captured[1][0]).toBe(
        path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      );
      expect(captured[1][1]).toBe("--version");
      expect(captured[2].windowsHide).toBe(true);
      expect(captured[2].windowsVerbatimArguments).toBeUndefined();
      expect(captured[2].stdio).toEqual(["inherit", "pipe", "pipe"]);
    } finally {
      existsSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });

  it("falls back to npm.cmd when npm-cli.js is unavailable", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const expectedComSpec = expectedTrustedCmdExe();

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      const captured = requireSpawnCall(0);
      expect(captured[0]).toBe(expectedComSpec);
      expect(captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(captured[1][3]).toContain("npm.cmd --version");
      expect(captured[2].windowsHide).toBe(true);
      expect(captured[2].windowsVerbatimArguments).toBe(true);
      expect(captured[2].stdio).toEqual(["inherit", "pipe", "pipe"]);
    } finally {
      existsSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });

  it("waits for Windows exitCode settlement after close reports null", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({
      closeCode: null,
      exitCode: null,
      exitCodeAfterClose: 0,
      exitCodeAfterCloseDelayMs: 50,
    });

    spawnMock.mockImplementation(() => child);

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("treats shimmed Windows commands without a reported exit code as success when they close cleanly", async () => {
    await expectShimmedWindowsCommandWithoutExitCodeSucceeds();
  });

  it("treats shimmed Windows commands without a reported exit code as success even when child.killed is true", async () => {
    await expectShimmedWindowsCommandWithoutExitCodeSucceeds({ killed: true });
  });

  it("uses cmd.exe wrapper with windowsVerbatimArguments in runExec for .cmd shims", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedComSpec = expectedTrustedCmdExe();

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "ok", "");
      },
    );

    try {
      await runExec("pnpm", ["--version"], 1000);
      const captured = requireExecFileCall(0);
      expectCmdWrappedInvocation({ captured, expectedComSpec });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("sets windowsHide on direct runExec invocations too", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "ok", "");
      },
    );

    try {
      await runExec("node", ["--version"], 1000);
      const captured = requireExecFileCall(0);
      expect(captured[0]).toBe("node");
      expect(captured[1]).toEqual(["--version"]);
      expect(captured[2].windowsHide).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("sets windowsHide on direct runCommandWithTimeout invocations too", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      const result = await runCommandWithTimeout(["node", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      const captured = requireSpawnCall(0);
      expect(captured[0]).toBe("node");
      expect(captured[1]).toEqual(["--version"]);
      expect(captured[2].windowsHide).toBe(true);
      expect(captured[2].windowsVerbatimArguments).toBeUndefined();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("kills the Windows process tree when the overall timeout elapses", async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({ autoClose: false });
    const taskkillChild = createMockChild();

    spawnMock.mockImplementationOnce(() => child).mockImplementationOnce(() => taskkillChild);

    try {
      const resultPromise = runCommandWithTimeout(["node", "idle.js"], { timeoutMs: 80 });

      await vi.advanceTimersByTimeAsync(81);
      expect(child.kill).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const taskkillCall = requireSpawnCall(1);
      expect(taskkillCall[0]).toBe("taskkill");
      expect(taskkillCall[1]).toEqual(["/PID", "1234", "/T", "/F"]);
      expect(taskkillCall[2]).toEqual({
        stdio: "ignore",
        windowsHide: true,
      });

      child.emit("close", null, "SIGKILL");
      const result = await resultPromise;
      expect(result.termination).toBe("timeout");
      expect(result.code).not.toBe(0);
    } finally {
      platformSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("decodes GBK stdout and stderr from runExec on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const stdout = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);
    const stderr = Buffer.from([0xa3, 0xbb]);

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        cb(null, stdout, stderr);
      },
    );

    try {
      const result = await runExec("node", ["gbk-output.js"], 1000);
      expect(result.stdout).toBe("测试");
      expect(result.stderr).toBe("；");
      const captured = requireExecFileCall(0);
      expect(captured[2].encoding).toBe("buffer");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("prefers valid UTF-8 stdout from runExec on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: Buffer, stderr: Buffer) => void,
      ) => {
        cb(null, Buffer.from("测试", "utf8"), Buffer.alloc(0));
      },
    );

    try {
      await expect(runExec("node", ["utf8-output.js"], 1000)).resolves.toEqual({
        stdout: "测试",
        stderr: "",
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("decodes spawn stdout once so GBK characters split across chunks survive", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({ autoClose: false });
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from([0xb2]));
        child.stdout.emit("data", Buffer.from([0xe2, 0xca]));
        child.stdout.emit("data", Buffer.from([0xd4]));
        child.emit("close", 0, null);
      });
      return child;
    });

    try {
      await expect(
        runCommandWithTimeout(["node", "gbk-output.js"], { timeoutMs: 1000 }),
      ).resolves.toEqual({
        pid: 1234,
        stdout: "测试",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        noOutputTimedOut: false,
      });
    } finally {
      platformSpy.mockRestore();
    }
  });
});
