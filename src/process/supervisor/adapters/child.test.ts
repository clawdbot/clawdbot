// Child adapter tests cover adapting child processes to supervisor runs.
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  expectRealExitWinsOverSigkillFallback,
  expectWaitStaysPendingUntilSigkillFallback,
  mockLinuxOomWrapperShell,
} from "./test-support.js";

const {
  spawnWithFallbackMock,
  signalProcessTreeMock,
  createWindowsOutputDecoderMock,
  createServiceChildRelayAdapterMock,
} = vi.hoisted(() => ({
  spawnWithFallbackMock: vi.fn(),
  signalProcessTreeMock: vi.fn(
    (_pid: number, _signal: string, opts?: { onComplete?: () => void }) => {
      opts?.onComplete?.();
    },
  ),
  createWindowsOutputDecoderMock: vi.fn(() => ({
    decode: (chunk: Buffer | string) => (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk),
    flush: () => "",
  })),
  createServiceChildRelayAdapterMock: vi.fn(),
}));

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  signalProcessTree: signalProcessTreeMock,
}));

vi.mock("../../../infra/windows-encoding.js", () => ({
  createWindowsOutputDecoder: createWindowsOutputDecoderMock,
}));

vi.mock("../service-child-relay-host.js", () => ({
  createServiceChildRelayAdapter: createServiceChildRelayAdapterMock,
}));

let createChildAdapter: typeof import("./child.js").createChildAdapter;
let getWindowsInstallRoots: typeof import("../../../infra/windows-install-roots.js").getWindowsInstallRoots;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "stdio", {
    value: [child.stdin, child.stdout, child.stderr],
    configurable: true,
  });
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  Object.defineProperty(child, "exitCode", { value: null, configurable: true, writable: true });
  Object.defineProperty(child, "signalCode", { value: null, configurable: true, writable: true });
  Object.defineProperty(child, "channel", { value: {}, configurable: true });
  Object.defineProperty(child, "connected", { value: true, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  const sendMock = vi.fn((_message: unknown, ...args: unknown[]) => {
    const callback = args.findLast((value) => typeof value === "function") as
      | ((error: Error | null) => void)
      | undefined;
    callback?.(null);
    return true;
  });
  const disconnectMock = vi.fn(() => {
    Object.defineProperty(child, "connected", { value: false, configurable: true, writable: true });
    child.emit("disconnect");
  });
  child.kill = killMock as ChildProcess["kill"];
  child.send = sendMock as ChildProcess["send"];
  child.disconnect = disconnectMock as ChildProcess["disconnect"];
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
  return { child, disconnectMock, killMock, sendMock, emitClose, emitExit };
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
    createServiceChildRelayAdapterMock.mockClear();
    createWindowsOutputDecoderMock.mockClear();
    createWindowsOutputDecoderMock.mockImplementation(() => ({
      decode: (chunk: Buffer | string) => (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk),
      flush: () => "",
    }));
    createServiceChildRelayAdapterMock.mockResolvedValue({
      pid: 9999,
      onStdout: vi.fn(),
      onStderr: vi.fn(),
      wait: vi.fn(),
      kill: vi.fn(),
      dispose: vi.fn(),
    });
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
    await Promise.resolve();

    // Detachment flag is now passed to signalProcessTree so it knows whether
    // it can safely group-kill via -pid. (#71662)
    const expectedDetached = process.platform !== "win32" && !process.env.OPENCLAW_SERVICE_MARKER;
    expect(signalProcessTreeMock).toHaveBeenCalledWith(
      4321,
      "SIGKILL",
      expect.objectContaining({ detached: expectedDetached }),
    );
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("creates owned worker trees in a dedicated POSIX process group without fallback", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "service-managed";
    const { child, disconnectMock, sendMock } = createStubChild();
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });

    const adapter = await createChildAdapter({
      argv: ["node", "worker"],
      ownedWorker: true,
      input: "{}",
    });

    expect(firstSpawnWithFallbackParams().options?.detached).toBe(process.platform !== "win32");
    expect(firstSpawnWithFallbackParams().fallbacks).toEqual([]);
    expect(firstSpawnWithFallbackParams().options?.stdio).toEqual(["pipe", "pipe", "pipe", "ipc"]);

    await adapter.openStartGate?.();
    expect(sendMock).toHaveBeenCalledWith(
      { type: "openclaw-worker-start-v1" },
      expect.any(Function),
    );
    adapter.closeStartGate?.();
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it.each([
    { order: "disconnect first", events: ["disconnect", "exit", "stdout", "stderr"] },
    { order: "disconnect last", events: ["stdout", "stderr", "exit", "disconnect"] },
    { order: "exit last", events: ["disconnect", "stdout", "stderr", "exit"] },
  ] as const)(
    "settles owned POSIX workers after all resources close ($order)",
    async ({ events }) => {
      vi.useFakeTimers();
      setPlatform("darwin");
      const { child, disconnectMock, emitExit, killMock } = createStubChild();
      // Node marks connected false before a queued IPC disconnect has completed.
      disconnectMock.mockImplementation(() => {
        child.connected = false;
      });
      spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
      const adapter = await createChildAdapter({
        argv: ["node", "worker"],
        ownedWorker: true,
        stdinMode: "pipe-open",
      });
      const settled = vi.fn();
      const wait = adapter.wait();
      void wait.then(settled);

      try {
        adapter.closeStartGate?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).not.toHaveBeenCalled();
        for (const [index, event] of events.entries()) {
          if (event === "exit") {
            emitExit(7);
          } else if (event === "disconnect") {
            child.emit("disconnect");
          } else {
            child[event]?.emit("end");
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).not.toHaveBeenCalled();
            child[event]?.emit("close");
          }
          await vi.advanceTimersByTimeAsync(0);
          if (index < events.length - 1) {
            expect(settled).not.toHaveBeenCalled();
          }
        }
        expect(settled).toHaveBeenCalledExactlyOnceWith({ code: 7, signal: null });
        await expect(wait).resolves.toEqual({ code: 7, signal: null });
        expect(signalProcessTreeMock).not.toHaveBeenCalled();
        expect(killMock).not.toHaveBeenCalled();
      } finally {
        adapter.dispose();
      }
    },
  );

  it("keeps ordinary POSIX child waits bound to close after exit and pipe closure", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { child, emitClose, emitExit } = createStubChild();
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({ argv: ["node", "-e", "process.exit(0)"] });
    const settled = vi.fn();
    const wait = adapter.wait();
    void wait.then(settled);

    try {
      emitExit(0);
      child.stdout?.emit("close");
      child.stderr?.emit("close");
      child.emit("disconnect");
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      emitClose(0);
      await expect(wait).resolves.toEqual({ code: 0, signal: null });
    } finally {
      adapter.dispose();
    }
  });

  it("waits for an owned worker's secret descriptor to close after delivery", async () => {
    vi.useFakeTimers();
    setPlatform("darwin");
    const { child, emitExit } = createStubChild();
    const secretStream = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream, null],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const transient = Buffer.from("synthetic-secret");
    const adapter = await createChildAdapter({
      argv: ["node", "worker"],
      ownedWorker: true,
      secretInput: { fd: 3, createData: () => transient },
    });
    const settled = vi.fn();
    const wait = adapter.wait();
    void wait.then(settled);

    try {
      expect(secretStream.writableFinished).toBe(true);
      expect(transient.equals(Buffer.alloc(transient.length))).toBe(true);
      adapter.closeStartGate?.();
      emitExit(0);
      child.stdout?.emit("close");
      child.stderr?.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      secretStream.destroy();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledExactlyOnceWith({ code: 0, signal: null });
      await expect(wait).resolves.toEqual({ code: 0, signal: null });
    } finally {
      secretStream.destroy();
      adapter.dispose();
    }
  });

  it("keeps ordinary children supervised through repeated operational errors", async () => {
    const { child, emitClose, emitExit } = createStubChild(7865);
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      stdinMode: "pipe-open",
    });
    const resolved = vi.fn();
    const rejected = vi.fn();
    const wait = adapter.wait();
    void wait.then(resolved, rejected);

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        expect(() => child.emit("error", error)).not.toThrow();
        expect(child.listenerCount("error")).toBe(1);
        expect(child.listenerCount("exit")).toBe(1);
        expect(child.listenerCount("close")).toBe(1);
        await Promise.resolve();
        expect(resolved).not.toHaveBeenCalled();
        expect(rejected).not.toHaveBeenCalled();
      }

      emitExit(0);
      emitClose(0);
      await expect(wait).resolves.toEqual({ code: 0, signal: null });
    } finally {
      adapter.dispose();
    }

    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  });

  it.each([
    { first: "error", waitBefore: true },
    { first: "error", waitBefore: false },
    { first: "close", waitBefore: true },
    { first: "close", waitBefore: false },
  ] as const)(
    "keeps the first owned worker $first outcome (waitBefore=$waitBefore)",
    async ({ first, waitBefore }) => {
      const { child, disconnectMock, emitClose } = createStubChild(7866);
      spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
      const adapter = await createChildAdapter({
        argv: ["node", "worker"],
        ownedWorker: true,
      });
      const error = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      const pending = Promise.allSettled(waitBefore ? [adapter.wait(), adapter.wait()] : []);

      try {
        if (first === "error") {
          child.emit("error", error);
          emitClose(0);
        } else {
          emitClose(0);
          child.emit("error", error);
        }
        // Cross a turn before late waits so an unhandled eager rejection fails the test.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const outcomes = [
          ...(await pending),
          ...(await Promise.allSettled([adapter.wait(), adapter.wait()])),
        ];
        let firstResult: Awaited<ReturnType<typeof adapter.wait>> | undefined;
        for (const outcome of outcomes) {
          if (first === "error") {
            expect(outcome.status).toBe("rejected");
            if (outcome.status === "rejected") {
              expect(outcome.reason).toBe(error);
            }
          } else {
            expect(outcome).toStrictEqual({
              status: "fulfilled",
              value: { code: 0, signal: null },
            });
            if (outcome.status === "fulfilled") {
              firstResult ??= outcome.value;
              expect(outcome.value).toBe(firstResult);
            }
          }
        }
      } finally {
        adapter.dispose();
      }

      expect(disconnectMock).toHaveBeenCalledOnce();
      expect(child.listenerCount("error")).toBe(0);
    },
  );

  it("preserves startup failure when a worker error arrives during secret delivery", async () => {
    const { child, killMock } = createStubChild();
    const deliveryError = new Error("secret delivery failed");
    const secretStream = new Writable({
      write(_chunk, _encoding, callback) {
        child.emit("error", new Error("worker IPC failed"));
        setImmediate(() => callback(deliveryError));
      },
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream, null],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const transient = Buffer.from("synthetic-secret");

    await expect(
      createChildAdapter({
        argv: ["node", "worker"],
        ownedWorker: true,
        secretInput: { fd: 3, createData: () => transient },
      }),
    ).rejects.toBe(deliveryError);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(killMock).toHaveBeenCalledWith("SIGKILL");
    expect(transient.equals(Buffer.alloc(transient.length))).toBe(true);
    child.removeAllListeners();
  });

  it("writes secret input to an extra descriptor and zeroes the transient buffer", async () => {
    const { child } = createStubChild();
    const secretStream = new PassThrough();
    const chunks: Buffer[] = [];
    secretStream.on("data", (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });
    const transient = Buffer.from("selected-secret", "utf8");

    await createChildAdapter({
      argv: ["claude", "-p"],
      stdinMode: "pipe-open",
      secretInput: {
        fd: 3,
        createData: () => transient,
      },
    });

    expect(firstSpawnWithFallbackParams().options?.stdio).toEqual([
      "pipe",
      "pipe",
      "pipe",
      process.platform === "win32" ? "overlapped" : "pipe",
    ]);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("selected-secret");
    expect(transient.equals(Buffer.alloc(transient.length))).toBe(true);
  });

  it("captures child close while secret input delivery is still pending", async () => {
    const { child, emitClose } = createStubChild();
    const secretStream = new Writable({
      write(_chunk, _encoding, callback) {
        emitClose(0);
        setImmediate(callback);
      },
    });
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, secretStream],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });

    const adapter = await createChildAdapter({
      argv: ["claude", "-p"],
      stdinMode: "pipe-open",
      secretInput: {
        fd: 3,
        createData: () => Buffer.from("selected-secret"),
      },
    });

    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
  });

  it("uses overlapped I/O for a Windows secret descriptor", async () => {
    setPlatform("win32");
    const { child } = createStubChild();
    Object.defineProperty(child, "stdio", {
      value: [child.stdin, child.stdout, child.stderr, new PassThrough()],
      configurable: true,
    });
    spawnWithFallbackMock.mockResolvedValue({
      child,
      usedFallback: false,
    });

    await createChildAdapter({
      argv: ["claude.exe", "-p"],
      secretInput: {
        fd: 3,
        createData: () => Buffer.from("secret"),
      },
    });

    expect(firstSpawnWithFallbackParams().options?.stdio?.[3]).toBe("overlapped");
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
    await Promise.resolve();

    expect(signalProcessTreeMock).toHaveBeenCalledWith(
      8888,
      "SIGKILL",
      expect.objectContaining({ detached: false }),
    );
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("selects the exact service relay instead of direct shared-group signaling", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "1";
    try {
      await createChildAdapter({
        argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
        exactEnv: true,
        stdinMode: "pipe-open",
      });
      expect(createServiceChildRelayAdapterMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "node",
          args: ["-e", "setTimeout(() => {}, 1000)"],
          stdinMode: "pipe-open",
        }),
      );
      expect(spawnWithFallbackMock).not.toHaveBeenCalled();
      expect(signalProcessTreeMock).not.toHaveBeenCalled();
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

  it("waits for Windows tree-kill completion before forced stream settlement", async () => {
    vi.useFakeTimers();
    setPlatform("win32");
    let resolveTreeKill: (() => void) | undefined;
    signalProcessTreeMock.mockImplementationOnce(
      (_pid: number, _signal: string, opts?: { onComplete?: () => void }) => {
        resolveTreeKill = opts?.onComplete;
      },
    );

    const stub = createStubChild(9753);
    spawnWithFallbackMock.mockResolvedValue({ child: stub.child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      stdinMode: "pipe-closed",
    });
    const settled = vi.fn();
    void adapter.wait().then(settled);

    adapter.kill("SIGKILL");
    stub.emitExit(null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    expect(stub.child.stdout?.destroyed).toBe(false);
    expect(stub.child.stderr?.destroyed).toBe(false);

    resolveTreeKill?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith({ code: null, signal: "SIGKILL" });
    expect(stub.child.stdout?.destroyed).toBe(true);
    expect(stub.child.stderr?.destroyed).toBe(true);
  });

  it("blocks Windows child close until tree-kill completion", async () => {
    vi.useFakeTimers();
    setPlatform("win32");
    let resolveTreeKill: (() => void) | undefined;
    signalProcessTreeMock.mockImplementationOnce(
      (_pid: number, _signal: string, opts?: { onComplete?: () => void }) => {
        resolveTreeKill = opts?.onComplete;
      },
    );

    const stub = createStubChild(9754);
    spawnWithFallbackMock.mockResolvedValue({ child: stub.child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      stdinMode: "pipe-closed",
    });
    const settled = vi.fn();
    void adapter.wait().then(settled);

    adapter.kill("SIGKILL");
    stub.emitExit(null, "SIGKILL");
    stub.emitClose(null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();

    resolveTreeKill?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toHaveBeenCalledWith({ code: null, signal: "SIGKILL" });
  });

  it.each([false, true])(
    "blocks drained Windows streams until tree-kill completion (ownedWorker=%s)",
    async (ownedWorker) => {
      vi.useFakeTimers();
      setPlatform("win32");
      let resolveTreeKill: (() => void) | undefined;
      signalProcessTreeMock.mockImplementationOnce(
        (_pid: number, _signal: string, opts?: { onComplete?: () => void }) => {
          resolveTreeKill = opts?.onComplete;
        },
      );

      const stub = createStubChild(9755);
      spawnWithFallbackMock.mockResolvedValue({ child: stub.child, usedFallback: false });
      const adapter = await createChildAdapter({
        argv: ["node", "-e", "setInterval(() => {}, 1000)"],
        stdinMode: "pipe-closed",
        ...(ownedWorker ? { ownedWorker: true } : {}),
      });
      const settled = vi.fn();
      void adapter.wait().then(settled);

      adapter.kill("SIGKILL");
      adapter.closeStartGate?.();
      stub.emitExit(null, "SIGKILL");
      stub.child.stdout?.emit("end");
      stub.child.stderr?.emit("end");
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      resolveTreeKill?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledWith({ code: null, signal: "SIGKILL" });
    },
  );

  it("preserves descendant output after ordinary Windows child exit", async () => {
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
    const stdout = vi.fn();
    const stderr = vi.fn();
    adapter.onStdout(stdout);
    adapter.onStderr(stderr);

    const settled = vi.fn();
    void adapter.wait().then((result) => {
      settled(result);
    });

    emitExit(0, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).not.toHaveBeenCalled();
    expect(child.stdout?.destroyed).toBe(false);
    expect(child.stderr?.destroyed).toBe(false);

    const stdoutPipe = child.stdout as PassThrough;
    const stderrPipe = child.stderr as PassThrough;
    stdoutPipe.write("late stdout");
    stderrPipe.write("late stderr");
    stdoutPipe.end();
    stderrPipe.end();
    await vi.runAllTimersAsync();

    expect(stdout).toHaveBeenCalledWith("late stdout");
    expect(stderr).toHaveBeenCalledWith("late stderr");
    expect(settled).toHaveBeenCalledWith({ code: 0, signal: null });
  });

  it("settles ordinary Windows exit when streams drain before exit and close is missing", async () => {
    setPlatform("win32");
    const stub = createStubChild(9756);
    spawnWithFallbackMock.mockResolvedValue({ child: stub.child, usedFallback: false });
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "process.exit(0)"],
      stdinMode: "pipe-closed",
    });
    const waitPromise = adapter.wait();
    const settled = vi.fn();
    void waitPromise.then(settled);

    stub.child.stdout?.emit("end");
    stub.child.stderr?.emit("end");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    stub.emitExit(0, null);
    await expect(waitPromise).resolves.toEqual({ code: 0, signal: null });
  });

  it("keeps the service relay out of Windows child mode", async () => {
    setPlatform("win32");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";

    await createAdapterHarness({ pid: 7777 });

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.options?.detached).toBe(false);
    expect(spawnArgs.fallbacks ?? []).toStrictEqual([]);
    expect(createServiceChildRelayAdapterMock).not.toHaveBeenCalled();
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
    const restoreLinuxShell = mockLinuxOomWrapperShell();
    process.env.BASH_ENV = "/tmp/bashenv";
    process.env.ENV = "/tmp/env";
    process.env.CDPATH = "/tmp";
    try {
      const { adapter } = await createAdapterHarness({
        pid: 3334,
        argv: ["/usr/bin/node", "-e", "process.exit(0)"],
      });
      expect(adapter.oomScoreWrapperSelected).toBe(true);
    } finally {
      restoreLinuxShell();
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

  it("keeps an exact Linux child environment out of the OOM shell wrapper", async () => {
    setPlatform("linux");
    const restoreLinuxShell = mockLinuxOomWrapperShell();
    const { child } = createStubChild(3335);
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    try {
      const adapter = await createChildAdapter({
        argv: ["/usr/bin/node", "-e", "process.exit(0)"],
        env: { HOME: "/worker-home", PATH: "/usr/bin" },
        exactEnv: true,
        stdinMode: "pipe-open",
      });
      expect(adapter.oomScoreWrapperSelected).toBe(false);
    } finally {
      restoreLinuxShell();
    }

    const spawnArgs = firstSpawnWithFallbackParams();
    expect(spawnArgs.argv).toEqual(["/usr/bin/node", "-e", "process.exit(0)"]);
    expect(spawnArgs.options?.env).toEqual({ HOME: "/worker-home", PATH: "/usr/bin" });
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
    const raw = vi.fn();

    adapter.onStdout(first, raw);
    adapter.onStdout(second);
    child.stdout?.emit("data", Buffer.from([0xb2]));

    expect(createWindowsOutputDecoderMock).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledWith("first");
    expect(second).toHaveBeenCalledWith("second");
    expect(raw).toHaveBeenCalledWith(Buffer.from([0xb2]));
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
