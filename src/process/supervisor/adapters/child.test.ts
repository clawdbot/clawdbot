// Child adapter tests cover adapting child processes to supervisor runs.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  expectRealExitWinsOverSigkillFallback,
  expectWaitStaysPendingUntilSigkillFallback,
} from "./test-support.js";

const { spawnWithFallbackMock, signalProcessTreeMock, createWindowsOutputDecoderMock } = vi.hoisted(
  () => ({
    spawnWithFallbackMock: vi.fn(),
    signalProcessTreeMock: vi.fn(),
    createWindowsOutputDecoderMock: vi.fn(() => ({
      decode: (chunk: Buffer | string) => (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk),
      flush: () => "",
    })),
  }),
);

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  signalProcessTree: signalProcessTreeMock,
}));

vi.mock("../../../infra/windows-encoding.js", () => ({
  createWindowsOutputDecoder: createWindowsOutputDecoderMock,
}));

let createChildAdapter: typeof import("./child.js").createChildAdapter;
let getWindowsInstallRoots: typeof import("../../../infra/windows-install-roots.js").getWindowsInstallRoots;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  Object.defineProperty(child, "exitCode", { value: null, configurable: true, writable: true });
  Object.defineProperty(child, "signalCode", { value: null, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  child.kill = killMock as ChildProcess["kill"];
  const emitClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.emit("close", code, signal);
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    Object.defineProperty(child, "exitCode", { value: code, configurable: true, writable: true });
    Object.defineProperty(child, "signalCode", {
      value: signal,
      configurable: true,
      writable: true,
    });
    child.emit("exit", code, signal);
  };
  return { child, killMock, emitClose, emitExit };
}

async function createAdapterHarness(params?: {
  pid?: number;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const { child, killMock } = createStubChild(params?.pid);
  spawnWithFallbackMock.mockResolvedValue({
    child,
    usedFallback: false,
  });
  const adapter = await createChildAdapter({
    argv: params?.argv ?? ["node", "-e", "setTimeout(() => {}, 1000)"],
    env: params?.env,
    stdinMode: "pipe-open",
  });
  return { adapter, killMock };
}

type SpawnWithFallbackParams = {
  argv?: string[];
  options?: {
    detached?: boolean;
    env?: NodeJS.ProcessEnv | Record<string, string>;
    stdio?: string[];
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  };
  fallbacks?: Array<{ options?: { detached?: boolean } }>;
};

function firstSpawnWithFallbackParams(): SpawnWithFallbackParams {
  const [call] = spawnWithFallbackMock.mock.calls;
  if (!call) {
    throw new Error("expected spawnWithFallback call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected spawnWithFallback params to be an object");
  }
  return params;
}

function firstMockArg(mock: { mock: { calls: readonly unknown[][] } }, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

function expectedTrustedCmdExe(): string {
  return path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
}

describe("createChildAdapter", () => {
  const originalServiceMarker = process.env.OPENCLAW_SERVICE_MARKER;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform,
    });
  };

  beforeEach(async () => {
    vi.resetModules();
    const accessSync = fs.accessSync.bind(fs);
    vi.spyOn(fs, "accessSync").mockImplementation((filePath, mode) => {
      if (String(filePath).toLowerCase() === "c:\\windows\\system32\\reg.exe") {
        throw new Error("registry lookup disabled for test");
      }
      return accessSync(filePath, mode);
    });
    ({ getWindowsInstallRoots } = await import("../../../infra/windows-install-roots.js"));
    ({ createChildAdapter } = await import("./child.js"));
    spawnWithFallbackMock.mockClear();
    signalProcessTreeMock.mockClear();
    createWindowsOutputDecoderMock.mockClear();
    createWindowsOutputDecoderMock.mockImplementation(() => ({
      decode: (chunk: Buffer | string) => (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk),
      flush: () => "",
    }));
    delete process.env.OPENCLAW_SERVICE_MARKER;
    vi.useRealTimers();
  });

  afterAll(() => {
    if (originalServiceMarker === undefined) {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    } else {
      process.env.OPENCLAW_SERVICE_MARKER = originalServiceMarker;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    vi.useRealTimers();
  });

  const createWindowsNpmShim = async (params: { command: string; packagePath: string[] }) => {
    const binDir = tempDirs.make("openclaw-child-shim-");
    const entrypoint = path.join(binDir, "node_modules", ...params.packagePath);
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, "", "utf8");
    const relativeEntrypoint = path.relative(binDir, entrypoint).replaceAll(path.sep, "\\");
    const shimHead =
      "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
    const shimCommand = entrypoint.endsWith(".exe")
      ? `"%dp0%\\${relativeEntrypoint}" %*\r\n`
      : `IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${relativeEntrypoint}" %*\r\n`;
    await writeFile(
      path.join(binDir, `${params.command}.cmd`),
      `${shimHead}${shimCommand}`,
      "utf8",
    );
    return { binDir, entrypoint };
  };

  it("uses process-tree kill for default SIGKILL", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 4321 });

    const spawnArgs = firstSpawnWithFallbackParams();
    // On Windows, detached defaults to false (headless Scheduled Task compat);
    // on POSIX, detached is true with a no-detach fallback.
    if (process.platform === "win32") {
      expect(spawnArgs.options?.detached).toBe(false);
      expect(spawnArgs.fallbacks).toStrictEqual([]);
    } else {
      expect(spawnArgs.options?.detached).toBe(true);
      expect(spawnArgs.fallbacks?.[0]?.options?.detached).toBe(false);
    }

    adapter.kill();

    // Detachment flag is now passed to signalProcessTree so it knows whether
    // it can safely group-kill via -pid. (#71662)
    const expectedDetached = process.platform !== "win32" && !process.env.OPENCLAW_SERVICE_MARKER;
    expect(signalProcessTreeMock).toHaveBeenCalledWith(4321, "SIGKILL", {
      detached: expectedDetached,
    });
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("passes detached:false to signalProcessTree when spawn fell back to no-detach (#71662 follow-up)", async () => {
    // Simulate the fallback scenario: spawnWithFallback retried with
    // detached:false because the initial detached spawn failed. The kill
    // closure must NOT group-kill since the child shares the gateway's group.
    const { child, killMock } = createStubChild(8888);
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: true,
      fallbackLabel: "no-detach",
    });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
      stdinMode: "pipe-open",
    });

    adapter.kill();

    expect(signalProcessTreeMock).toHaveBeenCalledWith(8888, "SIGKILL", { detached: false });
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("passes detached:false in service-managed mode where useDetached is false from the start (#71662)", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "1";
    try {
      const { adapter, killMock } = await createAdapterHarness({ pid: 9999 });
      adapter.kill();
      expect(signalProcessTreeMock).toHaveBeenCalledWith(9999, "SIGKILL", { detached: false });
      expect(killMock).toHaveBeenCalledWith("SIGKILL");
    } finally {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    }
  });

  it("uses process-tree kill for graceful SIGTERM cancellation", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 7654 });

    adapter.kill("SIGTERM");

    const expectedDetached = process.platform !== "win32" && !process.env.OPENCLAW_SERVICE_MARKER;
    expect(signalProcessTreeMock).toHaveBeenCalledWith(7654, "SIGTERM", {
      detached: expectedDetached,
    });
    expect(killMock).not.toHaveBeenCalled();
  });

  it("passes detached:false to process-tree SIGTERM when spawn fell back to no-detach", async () => {
    const { child, killMock } = createStubChild(8765);
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: true,
      fallbackLabel: "no-detach",
    });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
      stdinMode: "pipe-open",
    });

    adapter.kill("SIGTERM");

    expect(signalProcessTreeMock).toHaveBeenCalledWith(8765, "SIGTERM", {
      detached: false,
    });
    expect(killMock).not.toHaveBeenCalled();
  });

  it("uses direct child.kill for non-SIGTERM and non-SIGKILL signals", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 7654 });

    adapter.kill("SIGINT");

    expect(signalProcessTreeMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith("SIGINT");
  });

  it("preserves inherited stdin when no input pipe is requested", async () => {
    const { child } = createStubChild(5656);
    child.stdin = null;
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });

    const adapter = await createChildAdapter({
      argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
    });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.options?.stdio?.[0]).toBe("inherit");
    expect(adapter.stdin).toBeUndefined();
  });

  it("reports stdin as non-writable after end or destroy", async () => {
    const { adapter } = await createAdapterHarness({ pid: 6767 });

    expect(adapter.stdin?.writable).toBe(true);
    expect(adapter.stdin?.writableEnded).toBe(false);

    adapter.stdin?.end();
    expect(adapter.stdin?.writable).toBe(false);
    expect(adapter.stdin?.writableEnded).toBe(true);

    const writeCallback = vi.fn();
    adapter.stdin?.write("late", writeCallback);
    expect(firstMockArg(writeCallback, "write callback")).toBeInstanceOf(Error);

    adapter.stdin?.destroy?.();
    expect(adapter.stdin?.destroyed).toBe(true);
    expect(adapter.stdin?.writable).toBe(false);
  });

  it("reports pipe-closed stdin as ended", async () => {
    const { child } = createStubChild(3434);
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });

    const adapter = await createChildAdapter({
      argv: ["node", "-e", "process.exit(0)"],
      stdinMode: "pipe-closed",
    });

    expect(adapter.stdin?.writable).toBe(false);
    expect(adapter.stdin?.writableEnded).toBe(true);
  });

  it("wait does not settle immediately on SIGKILL", async () => {
    vi.useFakeTimers();
    const { adapter } = await createAdapterHarness({ pid: 4567 });

    await expectWaitStaysPendingUntilSigkillFallback(adapter.wait(), () => {
      adapter.kill();
    });
  });

  it("prefers real child close over the SIGKILL fallback settle", async () => {
    vi.useFakeTimers();
    const { adapter, emitClose, killMock } = await (async () => {
      const stub = createStubChild(2468);
      spawnWithFallbackMock.mockResolvedValue({
        child: stub.child,
        usedFallback: false,
      });
      const adapterValue = await createChildAdapter({
        argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
        stdinMode: "pipe-open",
      });
      return { ...stub, adapter: adapterValue };
    })();

    await expectRealExitWinsOverSigkillFallback({
      waitPromise: adapter.wait(),
      triggerKill: () => {
        adapter.kill();
      },
      emitExit: () => {
        emitClose(0, "SIGKILL");
      },
      expected: { code: 0, signal: "SIGKILL" },
    });
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("settles wait from exit state on Windows even when close never arrives", async () => {
    vi.useFakeTimers();
    setPlatform("win32");

    const { adapter, emitExit, child } = await (async () => {
      const stub = createStubChild(8642);
      spawnWithFallbackMock.mockResolvedValue({
        child: stub.child,
        usedFallback: false,
      });
      const adapterLocal = await createChildAdapter({
        argv: ["openclaw", "version"],
        stdinMode: "pipe-closed",
      });
      return { ...stub, adapter: adapterLocal };
    })();

    const settled = vi.fn();
    void adapter.wait().then((result) => {
      settled(result);
    });

    emitExit(0, null);
    child.stdout?.emit("end");
    child.stderr?.emit("end");
    await vi.advanceTimersByTimeAsync(300);

    expect(settled).toHaveBeenCalledWith({ code: 0, signal: null });
  });

  it("disables detached mode in service-managed runtime", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";

    await createAdapterHarness({ pid: 7777 });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.options?.detached).toBe(false);
    expect(spawnArgs.fallbacks ?? []).toStrictEqual([]);
  });

  it("keeps inherited env when no override env is provided on non-Linux", async () => {
    setPlatform("darwin");

    await createAdapterHarness({
      pid: 3333,
      argv: ["node", "-e", "process.exit(0)"],
    });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.argv).toEqual(["node", "-e", "process.exit(0)"]);
    expect(spawnArgs.options?.env).toBeUndefined();
  });

  it("wraps Windows command shims through trusted cmd.exe", async () => {
    setPlatform("win32");

    await createAdapterHarness({
      pid: 3335,
      argv: ["pnpm", "--version"],
      env: { PATH: "", PATHEXT: ".EXE;.CMD;.BAT" },
    });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.argv).toEqual([
      expectedTrustedCmdExe(),
      "/d",
      "/s",
      "/c",
      "pnpm.cmd --version",
    ]);
    expect(spawnArgs.options?.detached).toBe(false);
    expect(spawnArgs.options?.windowsHide).toBe(true);
    expect(spawnArgs.options?.windowsVerbatimArguments).toBe(true);
    expect(spawnArgs.fallbacks).toStrictEqual([]);
  });

  it("unwraps Gemini's npm shim and preserves prompt argv on Windows", async () => {
    setPlatform("win32");
    const { binDir, entrypoint } = await createWindowsNpmShim({
      command: "gemini",
      packagePath: ["@google", "gemini-cli", "bundle", "gemini.js"],
    });
    const nodePath = path.join(binDir, "node.exe");
    await writeFile(nodePath, "", "utf8");
    const prompt = "explain A&B | C > D and 100% coverage";

    await createAdapterHarness({
      pid: 3336,
      argv: ["gemini", "--prompt", prompt],
      env: { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT" },
    });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.argv?.[0]?.toLowerCase()).toBe(nodePath.toLowerCase());
    expect(spawnArgs.argv?.slice(1)).toEqual([entrypoint, "--prompt", prompt]);
    expect(spawnArgs.options?.windowsVerbatimArguments).toBeUndefined();
    expect(spawnArgs.fallbacks).toStrictEqual([]);
  });

  it("unwraps Claude's npm shim to its native executable on Windows", async () => {
    setPlatform("win32");
    const { binDir, entrypoint } = await createWindowsNpmShim({
      command: "claude",
      packagePath: ["@anthropic-ai", "claude-code", "bin", "claude.exe"],
    });

    await createAdapterHarness({
      pid: 3337,
      argv: ["claude", "--version"],
      env: { PATH: binDir, PATHEXT: ".EXE;.CMD;.BAT" },
    });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.argv).toEqual([entrypoint, "--version"]);
    expect(spawnArgs.options?.windowsVerbatimArguments).toBeUndefined();
    expect(spawnArgs.fallbacks).toStrictEqual([]);
  });

  it("wraps Linux child spawns and strips shell-init env", async () => {
    const originalBashEnv = process.env.BASH_ENV;
    const originalEnv = process.env.ENV;
    const originalCdpath = process.env.CDPATH;
    setPlatform("linux");
    process.env.BASH_ENV = "/tmp/bashenv";
    process.env.ENV = "/tmp/env";
    process.env.CDPATH = "/tmp";
    try {
      await createAdapterHarness({
        pid: 3334,
        argv: ["/usr/bin/node", "-e", "process.exit(0)"],
      });
    } finally {
      if (originalBashEnv === undefined) {
        delete process.env.BASH_ENV;
      } else {
        process.env.BASH_ENV = originalBashEnv;
      }
      if (originalEnv === undefined) {
        delete process.env.ENV;
      } else {
        process.env.ENV = originalEnv;
      }
      if (originalCdpath === undefined) {
        delete process.env.CDPATH;
      } else {
        process.env.CDPATH = originalCdpath;
      }
    }

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.argv?.slice(0, 4)).toEqual([
      "/bin/sh",
      "-c",
      'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
      "/usr/bin/node",
    ]);
    expect(spawnArgs.argv?.slice(4)).toEqual(["-e", "process.exit(0)"]);
    if (!spawnArgs.options?.env) {
      throw new Error("expected child process env options");
    }
    expect(spawnArgs.options.env.BASH_ENV).toBeUndefined();
    expect(spawnArgs.options.env.ENV).toBeUndefined();
    expect(spawnArgs.options.env.CDPATH).toBeUndefined();
  });

  it("passes explicit env overrides as strings", async () => {
    await createAdapterHarness({
      pid: 4444,
      argv: ["node", "-e", "process.exit(0)"],
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.options?.env).toEqual({ FOO: "bar", COUNT: "12" });
  });

  it("uses a separate stdout decoder for each listener", async () => {
    const decoderOutputs = ["first", "second"];
    createWindowsOutputDecoderMock.mockImplementation(() => {
      const output = decoderOutputs.shift() ?? "";
      return {
        decode: () => output,
        flush: () => "",
      };
    });
    const { child } = createStubChild(5555);
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "process.exit(0)"],
      stdinMode: "pipe-open",
    });
    const first = vi.fn();
    const second = vi.fn();

    adapter.onStdout(first);
    adapter.onStdout(second);
    child.stdout?.emit("data", Buffer.from([0xb2]));

    expect(createWindowsOutputDecoderMock).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledWith("first");
    expect(second).toHaveBeenCalledWith("second");
  });

  it("guards stream errors before output listeners are registered", async () => {
    vi.useFakeTimers();
    setPlatform("win32");
    const { child, emitExit } = createStubChild(6666);
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
      stdinMode: "pipe-open",
    });

    const stdoutErr = new Error("simulated stdout pipe error");
    const stderrErr = new Error("simulated stderr pipe error");
    const settled = vi.fn();
    void adapter.wait().then(settled);

    emitExit(0, null);
    expect(() => child.stdout?.emit("error", stdoutErr)).not.toThrow();
    expect(() => child.stderr?.emit("error", stderrErr)).not.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).not.toHaveBeenCalled();

    adapter.onStdout(() => {});
    adapter.onStdout(() => {});
    adapter.onStderr(() => {});
    adapter.onStderr(() => {});

    expect(child.stdout?.listenerCount("error")).toBe(1);
    expect(child.stderr?.listenerCount("error")).toBe(1);

    child.stdout?.emit("close");
    child.stderr?.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith({ code: 0, signal: null });
  });
});
