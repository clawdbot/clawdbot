import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRealExitWinsOverSigkillFallback,
  expectWaitStaysPendingUntilSigkillFallback,
} from "./test-support.js";

const { spawnWithFallbackMock, killProcessTreeMock, createWindowsOutputDecoderMock } = vi.hoisted(
  () => ({
    spawnWithFallbackMock: vi.fn(),
    killProcessTreeMock: vi.fn(),
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
  killProcessTree: killProcessTreeMock,
}));

vi.mock("../../../infra/windows-encoding.js", () => ({
  createWindowsOutputDecoder: createWindowsOutputDecoderMock,
}));

let createChildAdapter: typeof import("./child.js").createChildAdapter;

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

describe("createChildAdapter", () => {
  const originalServiceMarker = process.env.OPENCLAW_SERVICE_MARKER;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform,
    });
  };

  beforeAll(async () => {
    ({ createChildAdapter } = await import("./child.js"));
  });

  beforeEach(() => {
    spawnWithFallbackMock.mockClear();
    killProcessTreeMock.mockClear();
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
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    vi.useRealTimers();
  });

  it("uses process-tree kill for default SIGKILL", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 4321 });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    // On Windows, detached defaults to false (headless Scheduled Task compat);
    // on POSIX, detached is true with a no-detach fallback.
    if (process.platform === "win32") {
      expect(spawnArgs.options?.detached).toBe(false);
      expect(spawnArgs.fallbacks).toEqual([]);
    } else {
      expect(spawnArgs.options?.detached).toBe(true);
      expect(spawnArgs.fallbacks?.[0]?.options?.detached).toBe(false);
    }

    adapter.kill();

    // Detachment flag is now passed to killProcessTree so it knows whether
    // it can safely group-kill via -pid. (#71662)
    const expectedDetached = process.platform !== "win32" && !process.env.OPENCLAW_SERVICE_MARKER;
    expect(killProcessTreeMock).toHaveBeenCalledWith(4321, { detached: expectedDetached });
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("passes detached:false to killProcessTree when spawn fell back to no-detach (#71662 follow-up)", async () => {
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

    expect(killProcessTreeMock).toHaveBeenCalledWith(8888, { detached: false });
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("passes detached:false in service-managed mode where useDetached is false from the start (#71662)", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "1";
    try {
      const { adapter, killMock } = await createAdapterHarness({ pid: 9999 });
      adapter.kill();
      expect(killProcessTreeMock).toHaveBeenCalledWith(9999, { detached: false });
      expect(killMock).toHaveBeenCalledWith("SIGKILL");
    } finally {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    }
  });

  it("uses direct child.kill for non-SIGKILL signals", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 7654 });

    adapter.kill("SIGTERM");

    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith("SIGTERM");
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
      const adapter = await createChildAdapter({
        argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
        stdinMode: "pipe-open",
      });
      return { ...stub, adapter };
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
      const adapter = await createChildAdapter({
        argv: ["openclaw", "version"],
        stdinMode: "pipe-closed",
      });
      return { ...stub, adapter };
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

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    expect(spawnArgs.options?.detached).toBe(false);
    expect(spawnArgs.fallbacks ?? []).toEqual([]);
  });

  it("keeps inherited env when no override env is provided on non-Linux", async () => {
    setPlatform("darwin");

    await createAdapterHarness({
      pid: 3333,
      argv: ["node", "-e", "process.exit(0)"],
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      argv?: string[];
      options?: { env?: NodeJS.ProcessEnv };
    };
    expect(spawnArgs.argv).toEqual(["node", "-e", "process.exit(0)"]);
    expect(spawnArgs.options?.env).toBeUndefined();
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

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      argv?: string[];
      options?: { env?: NodeJS.ProcessEnv };
    };
    expect(spawnArgs.argv?.slice(0, 4)).toEqual([
      "/bin/sh",
      "-c",
      'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
      "/usr/bin/node",
    ]);
    expect(spawnArgs.argv?.slice(4)).toEqual(["-e", "process.exit(0)"]);
    expect(spawnArgs.options?.env).toBeDefined();
    expect(spawnArgs.options?.env?.BASH_ENV).toBeUndefined();
    expect(spawnArgs.options?.env?.ENV).toBeUndefined();
    expect(spawnArgs.options?.env?.CDPATH).toBeUndefined();
  });

  it("passes explicit env overrides as strings", async () => {
    await createAdapterHarness({
      pid: 4444,
      argv: ["node", "-e", "process.exit(0)"],
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: Record<string, string> };
    };
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
});
