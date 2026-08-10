// Windows exec tests cover trusted command wrapping, tree termination, and output decoding.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const execaMock = vi.fn();
const isRegularFileMock = vi.fn();
const resolveExecutableFromPathEnvMock = vi.fn();
const resolveExecutablePathCandidateMock = vi.fn();
const spawnSyncMock = vi.fn();

type MockResult = {
  cause?: unknown;
  code?: string;
  exitCode?: number;
  failed: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated: boolean;
  signal?: NodeJS.Signals;
  stderr?: Buffer;
  stdout?: Buffer;
  timedOut?: boolean;
};

type MockSubprocess = EventEmitter & {
  nodeChildProcess: MockSubprocess;
  exitCode: number | null;
  finish: (result?: Partial<MockResult>) => void;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  pid: number;
  signalCode: NodeJS.Signals | null;
  stderr: PassThrough;
  stdout: PassThrough;
  catch: Promise<MockResult>["catch"];
  finally: Promise<MockResult>["finally"];
  then: Promise<MockResult>["then"];
};

type ExecaCall = [string, string[], Record<string, unknown>];

function createMockSubprocess(params?: {
  autoFinish?: boolean;
  exitCode?: number;
  signal?: NodeJS.Signals;
  stderr?: Buffer;
  stderrChunks?: Buffer[];
  stdout?: Buffer;
  stdoutChunks?: Buffer[];
}): MockSubprocess {
  const child = new EventEmitter() as MockSubprocess;
  child.nodeChildProcess = child;
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  let resolve!: (result: MockResult) => void;
  const completion = new Promise<MockResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  // oxlint-disable-next-line unicorn/no-thenable -- Stub combines Execa's promise with its exposed Node child.
  child.then = completion.then.bind(completion);
  child.catch = completion.catch.bind(completion);
  child.finally = completion.finally.bind(completion);
  child.finish = (overrides = {}) => {
    for (const chunk of params?.stdoutChunks ?? []) {
      child.stdout.write(chunk);
    }
    for (const chunk of params?.stderrChunks ?? []) {
      child.stderr.write(chunk);
    }
    const exitCode = Object.hasOwn(overrides, "exitCode")
      ? overrides.exitCode
      : (params?.exitCode ?? 0);
    const signal = overrides.signal ?? params?.signal;
    child.exitCode = signal ? null : (exitCode ?? null);
    child.signalCode = signal ?? null;
    child.emit("exit", child.exitCode, child.signalCode);
    resolve({
      exitCode: signal ? undefined : exitCode,
      failed: signal !== undefined || exitCode !== 0,
      isTerminated: signal !== undefined,
      signal,
      stderr: params?.stderr ?? Buffer.concat(params?.stderrChunks ?? []),
      stdout: params?.stdout ?? Buffer.concat(params?.stdoutChunks ?? []),
      ...overrides,
    });
  };
  if (params?.autoFinish !== false) {
    queueMicrotask(() => child.finish());
  }
  return child;
}

function requireExecaCall(index: number): ExecaCall {
  const call = execaMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected execa call ${index}`);
  }
  return call as ExecaCall;
}

function expectedTrustedCmdExe(): string {
  return path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
}

function expectCmdWrappedInvocation(call: ExecaCall, commandFragment = "pnpm.cmd") {
  expect(call[0]).toBe(expectedTrustedCmdExe());
  expect(call[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(call[1][3]).toContain(commandFragment);
  expect(call[1][3]).toContain("--version");
  expect(call[2]).toMatchObject({
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

let runCommandWithTimeout: typeof import("./exec.js").runCommandWithTimeout;
let runUtf8CommandWithTimeout: typeof import("./exec.js").runUtf8CommandWithTimeout;
let runExec: typeof import("./exec.js").runExec;
let spawnCommand: typeof import("./exec.js").spawnCommand;
let getWindowsInstallRoots: typeof import("../infra/windows-install-roots.js").getWindowsInstallRoots;
let getWindowsSystem32ExePath: typeof import("../infra/windows-install-roots.js").getWindowsSystem32ExePath;

describe("Windows command execution", () => {
  beforeEach(async () => {
    vi.resetModules();
    const accessSync = fs.accessSync.bind(fs);
    vi.spyOn(fs, "accessSync").mockImplementation((filePath, mode) => {
      if (String(filePath).toLowerCase() === "c:\\windows\\system32\\reg.exe") {
        throw new Error("registry lookup disabled for test");
      }
      return accessSync(filePath, mode);
    });
    vi.doMock("execa", () => ({ execa: execaMock }));
    vi.doMock("../infra/executable-path.js", async () => {
      const actual = await vi.importActual<typeof import("../infra/executable-path.js")>(
        "../infra/executable-path.js",
      );
      return {
        ...actual,
        isRegularFile: isRegularFileMock,
        resolveExecutableFromPathEnv: resolveExecutableFromPathEnvMock,
        resolveExecutablePathCandidate: resolveExecutablePathCandidateMock,
      };
    });
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawnSync: spawnSyncMock };
    });
    ({ getWindowsInstallRoots, getWindowsSystem32ExePath } =
      await import("../infra/windows-install-roots.js"));
    ({ runCommandWithTimeout, runExec, runUtf8CommandWithTimeout, spawnCommand } =
      await import("./exec.js"));
  });

  afterAll(() => {
    vi.doUnmock("execa");
    vi.doUnmock("../infra/executable-path.js");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockImplementation(() => createMockSubprocess());
    isRegularFileMock.mockReset();
    isRegularFileMock.mockReturnValue(true);
    resolveExecutableFromPathEnvMock.mockReset();
    resolveExecutableFromPathEnvMock.mockImplementation((command: string) => {
      const basename = path.win32.basename(command).toLowerCase();
      if (["corepack", "pnpm", "yarn"].includes(basename)) {
        return undefined;
      }
      if (command.includes("\\")) {
        return command;
      }
      const extension = path.extname(command) || path.win32.extname(command);
      return path.win32.join(
        "C:\\openclaw-test-bin",
        extension ? command : `${path.win32.basename(command)}.exe`,
      );
    });
    resolveExecutablePathCandidateMock.mockReset();
    resolveExecutablePathCandidateMock.mockImplementation((command: string) => command);
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ stdout: "Active code page: 936", stderr: "" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("wraps .cmd commands through trusted cmd.exe", async () => {
    await withMockedWindowsPlatform(async () => {
      await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1_000 });
      expectCmdWrappedInvocation(requireExecaCall(0));
    });
  });

  it("ignores ComSpec when selecting the Windows command wrapper", async () => {
    const previousComSpec = process.env.ComSpec;
    const previousSystemRoot = process.env.SystemRoot;
    process.env.ComSpec = "C:\\workspace\\evil\\cmd.exe";
    process.env.SystemRoot = "C:\\Windows";
    try {
      await withMockedWindowsPlatform(async () => {
        await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1_000 });
        expect(requireExecaCall(0)[0].toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
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
    }
  });

  it("resolves implicit batch shims before Execa can consult ComSpec", async () => {
    await withTempDir("openclaw-execa-windows-shim-", async (binDir) => {
      const shimPath = path.join(binDir, "custom-shim.cmd");
      fs.writeFileSync(shimPath, "@echo off\r\n", "utf8");
      resolveExecutableFromPathEnvMock.mockReturnValueOnce(shimPath);

      await withMockedWindowsPlatform(async () => {
        void spawnCommand(["custom-shim", "--version"], {
          baseEnv: {
            ComSpec: "C:\\workspace\\evil\\cmd.exe",
            PATH: binDir,
            PATHEXT: ".CMD",
          },
        });
        const call = requireExecaCall(0);
        expect(call[0]).toBe(expectedTrustedCmdExe());
        expect(call[1][3]).toContain(`${shimPath} --version`);
      });
    });
  });

  it("rejects unresolved commands before Execa can consult ambient ComSpec", async () => {
    resolveExecutableFromPathEnvMock.mockReturnValueOnce(undefined);

    await withMockedWindowsPlatform(async () => {
      expect(() =>
        spawnCommand(["missing\r\ncalc.exe"], {
          baseEnv: {
            ComSpec: "C:\\workspace\\evil\\cmd.exe",
            PATH: "C:\\openclaw-test-bin",
            PATHEXT: ".EXE;.CMD;.BAT;.COM",
          },
        }),
      ).toThrow("ENOENT");
      expect(execaMock).not.toHaveBeenCalled();
    });
  });

  it("rejects unsupported Windows command types before Execa", async () => {
    resolveExecutableFromPathEnvMock.mockReturnValueOnce("C:\\tools\\script.ps1");

    await withMockedWindowsPlatform(async () => {
      expect(() => spawnCommand(["script.ps1"])).toThrow("Unsupported Windows command extension");
      expect(execaMock).not.toHaveBeenCalled();
    });
  });

  it("escapes command arguments inside the trusted cmd.exe wrapper", async () => {
    await withMockedWindowsPlatform(async () => {
      await runCommandWithTimeout(["pnpm", "run", "value^with^carets"], { timeoutMs: 1_000 });
      const commandLine = String(requireExecaCall(0)[1][3]);
      expect(commandLine).toContain("value^^with^^carets");
    });
  });

  it("spawns node plus npm-cli.js instead of npm.cmd when available", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    await withMockedWindowsPlatform(async () => {
      void spawnCommand(["npm", "--version"]);
      const [command, args, options] = requireExecaCall(0);
      expect(path.win32.basename(command).toLowerCase()).toBe("node.exe");
      expect(args[0]).toContain(path.join("node_modules", "npm", "bin", "npm-cli.js"));
      expect(args[1]).toBe("--version");
      expect(options.shell).toBe(false);
    });
  });

  it("falls back to a trusted npm.cmd wrapper when npm-cli.js is unavailable", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    await withMockedWindowsPlatform(async () => {
      void spawnCommand(["npm", "--version"]);
      expectCmdWrappedInvocation(requireExecaCall(0), "npm.cmd");
    });
  });

  it("sets windowsHide and disables shell on direct commands", async () => {
    await withMockedWindowsPlatform(async () => {
      void spawnCommand(["node", "script.js"]);
      const [command, , options] = requireExecaCall(0);
      expect(path.win32.basename(command).toLowerCase()).toBe("node.exe");
      expect(options).toMatchObject({ shell: false, windowsHide: true });
    });
  });

  it("infers success when a spawned Windows shim has no exit state", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    execaMock.mockReturnValueOnce(command);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["pnpm", "--version"], {
        timeoutMs: 1_000,
      });
      command.finish({ exitCode: undefined, failed: true });
      await vi.advanceTimersByTimeAsync(251);

      await expect(resultPromise).resolves.toMatchObject({ code: 0, termination: "exit" });
    });
  });

  it("preserves a delayed nonzero exit code from a Windows shim", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    execaMock.mockReturnValueOnce(command);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["pnpm", "--version"], {
        timeoutMs: 1_000,
      });
      command.finish({ exitCode: undefined, failed: true });
      setTimeout(() => {
        command.exitCode = 7;
      }, 20);
      await vi.advanceTimersByTimeAsync(30);

      await expect(resultPromise).resolves.toMatchObject({ code: 7, termination: "exit" });
    });
  });

  it("sanitizes a Windows shim launch error without an exit state", async () => {
    const command = createMockSubprocess({ autoFinish: false });
    execaMock.mockReturnValueOnce(command);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["pnpm", "--version"], {
        timeoutMs: 1_000,
      });
      command.finish({
        cause: new Error("spawn pnpm ENOENT"),
        code: "ENOENT",
        exitCode: undefined,
        failed: true,
      });

      await expect(resultPromise).rejects.toMatchObject({
        code: "ENOENT",
        message: "Command failed during launch or output capture (ENOENT)",
      });
    });
  });

  it("does not time out after the direct child exits while output settles", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    execaMock.mockReturnValueOnce(command);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "quick.js"], { timeoutMs: 80 });
      command.exitCode = 0;
      command.emit("exit", 0, null);

      await vi.advanceTimersByTimeAsync(81);
      expect(execaMock).toHaveBeenCalledTimes(1);
      expect(command.stdout.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(19);
      expect(command.stdout.destroyed).toBe(false);
      await vi.advanceTimersToNextTimerAsync();
      expect(command.stdout.destroyed).toBe(true);
      expect(command.stderr.destroyed).toBe(true);

      command.finish();
      await expect(resultPromise).resolves.toMatchObject({ code: 0, termination: "exit" });
    });
  });

  it("gracefully then force-kills a Windows process tree", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    execaMock
      .mockImplementationOnce(() => command)
      .mockImplementation(() => createMockSubprocess());

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "idle.js"], {
        killProcessTree: true,
        timeoutMs: 80,
      });
      await vi.advanceTimersByTimeAsync(81);
      expect(requireExecaCall(1).slice(0, 2)).toEqual([
        getWindowsSystem32ExePath("taskkill.exe"),
        ["/PID", "1234", "/T"],
      ]);
      expect(command.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(requireExecaCall(2)[1]).toEqual(["/PID", "1234", "/T", "/F"]);
      command.finish({ signal: "SIGKILL" });

      await expect(resultPromise).resolves.toMatchObject({ code: 124, termination: "timeout" });
    });
  });

  it("keeps forced Windows tree escalation after graceful taskkill returns nonzero", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    execaMock
      .mockImplementationOnce(() => command)
      .mockImplementationOnce(() => createMockSubprocess({ exitCode: 1 }))
      .mockImplementation(() => createMockSubprocess());

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "idle.js"], {
        killProcessTree: true,
        timeoutMs: 80,
      });
      await vi.advanceTimersByTimeAsync(81);
      expect(requireExecaCall(1)[1]).toEqual(["/PID", "1234", "/T"]);

      await vi.advanceTimersByTimeAsync(300);
      expect(requireExecaCall(2)[1]).toEqual(["/PID", "1234", "/T", "/F"]);
      command.finish({ signal: "SIGKILL" });

      await expect(resultPromise).resolves.toMatchObject({ code: 124, termination: "timeout" });
    });
  });

  it("waits for forced taskkill before aborting the live Windows root", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    const forcedTaskkill = createMockSubprocess({ autoFinish: false });
    execaMock
      .mockImplementationOnce(() => command)
      .mockImplementationOnce(() => createMockSubprocess())
      .mockImplementationOnce(() => forcedTaskkill);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "idle.js"], {
        killProcessTree: true,
        timeoutMs: 80,
      });
      const cancelSignal = requireExecaCall(0)[2].cancelSignal as AbortSignal;

      await vi.advanceTimersByTimeAsync(381);
      expect(requireExecaCall(2)[1]).toEqual(["/PID", "1234", "/T", "/F"]);
      expect(cancelSignal.aborted).toBe(false);

      forcedTaskkill.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelSignal.aborted).toBe(true);

      command.finish({ signal: "SIGKILL" });
      await expect(resultPromise).resolves.toMatchObject({ code: 124, termination: "timeout" });
    });
  });

  it("waits for immediate forced taskkill before aborting the Windows root", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    const forcedTaskkill = createMockSubprocess({ autoFinish: false });
    execaMock.mockImplementationOnce(() => command).mockImplementationOnce(() => forcedTaskkill);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "idle.js"], {
        killProcessTree: false,
        timeoutMs: 80,
      });
      const cancelSignal = requireExecaCall(0)[2].cancelSignal as AbortSignal;

      await vi.advanceTimersByTimeAsync(81);
      expect(requireExecaCall(1)[1]).toEqual(["/PID", "1234", "/T", "/F"]);
      expect(cancelSignal.aborted).toBe(false);

      forcedTaskkill.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelSignal.aborted).toBe(true);

      command.finish({ signal: "SIGKILL" });
      await expect(resultPromise).resolves.toMatchObject({ code: 124, termination: "timeout" });
    });
  });

  it("decodes GBK stdout and stderr from runExec", async () => {
    execaMock.mockImplementationOnce(() =>
      createMockSubprocess({
        stderr: Buffer.from([0xa3, 0xbb]),
        stdout: Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
      }),
    );
    await withMockedWindowsPlatform(async () => {
      await expect(runExec("node", ["gbk-output.js"], 1_000)).resolves.toEqual({
        stdout: "测试",
        stderr: "；",
      });
      expect(requireExecaCall(0)[2].encoding).toBe("buffer");
    });
  });

  it("prefers valid UTF-8 output from runExec", async () => {
    execaMock.mockImplementationOnce(() =>
      createMockSubprocess({ stdout: Buffer.from("测试", "utf8") }),
    );
    await withMockedWindowsPlatform(async () => {
      await expect(runExec("node", ["utf8-output.js"], 1_000)).resolves.toEqual({
        stdout: "测试",
        stderr: "",
      });
    });
  });

  it("keeps truncated UTF-8 head output on a code point boundary", async () => {
    execaMock.mockImplementationOnce(() =>
      createMockSubprocess({
        stdoutChunks: [Buffer.from("a😀z", "utf8")],
        stderrChunks: [Buffer.from("b😀y", "utf8")],
      }),
    );
    await withMockedWindowsPlatform(async () => {
      await expect(
        runUtf8CommandWithTimeout(["node", "utf8-output.js"], {
          maxOutputBytes: 3,
          outputCapture: "head",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        stdout: "a",
        stderr: "b",
        stdoutTruncatedBytes: 5,
        stderrTruncatedBytes: 5,
      });
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  it("preserves complete legacy-code-page characters in truncated head output", async () => {
    execaMock.mockImplementationOnce(() =>
      createMockSubprocess({ stdoutChunks: [Buffer.from([0x61, 0xb2, 0xe2, 0xca, 0xd4])] }),
    );
    await withMockedWindowsPlatform(async () => {
      await expect(
        runCommandWithTimeout(["node", "gbk-output.js"], {
          maxOutputBytes: 3,
          outputCapture: "head",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        stdout: "a测",
        stdoutTruncatedBytes: 2,
      });
    });
  });

  it("decodes split GBK chunks after complete output capture", async () => {
    execaMock.mockImplementationOnce(() =>
      createMockSubprocess({
        stdoutChunks: [Buffer.from([0xb2]), Buffer.from([0xe2, 0xca]), Buffer.from([0xd4])],
      }),
    );
    await withMockedWindowsPlatform(async () => {
      await expect(
        runCommandWithTimeout(["node", "gbk-output.js"], { timeoutMs: 1_000 }),
      ).resolves.toMatchObject({ code: 0, stdout: "测试", termination: "exit" });
    });
  });
});
