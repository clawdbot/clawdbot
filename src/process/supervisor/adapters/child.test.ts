import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectRealExitWinsOverSigkillFallback,
  expectWaitStaysPendingUntilSigkillFallback,
} from "./test-support.js";

const { spawnWithFallbackMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnWithFallbackMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
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

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321);
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
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

  it("keeps inherited env when no override env is provided", async () => {
    await createAdapterHarness({
      pid: 3333,
      argv: ["node", "-e", "process.exit(0)"],
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: NodeJS.ProcessEnv };
    };
    expect(spawnArgs.options?.env).toBeUndefined();
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
});
