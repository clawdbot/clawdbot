import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  ensureDependency: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  getRuntimeConfig: vi.fn(),
  replaceConfigFile: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  killProcessTree: vi.fn(),
  spawn: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => mocks.log }));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: mocks.spawn },
  );
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: mocks.killProcessTree,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.getRuntimeConfig,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./gmail-setup-utils.js", () => ({
  ensureDependency: mocks.ensureDependency,
  ensureGcloudAuth: vi.fn(),
  ensureSubscription: vi.fn(),
  ensureTailscaleEndpoint: mocks.ensureTailscaleEndpoint,
  ensureTopic: vi.fn(),
  resolveProjectIdFromGogCredentials: vi.fn(),
  runGcloud: vi.fn(),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutable: vi.fn((name: string) => name),
}));

const { runGmailService } = await import("./gmail-ops.js");
const { stopGmailWatcher } = await import("./gmail-watcher.js");

const commandSuccess = { code: 0, stdout: "", stderr: "" };
const signals = ["SIGINT", "SIGTERM"] as const;

function createGmailConfig() {
  return {
    hooks: {
      enabled: true,
      token: "hook-token",
      gmail: {
        account: "me@example.com",
        topic: "projects/demo/topics/gmail",
        pushToken: "push-token",
        tailscale: { mode: "off" as const },
        renewEveryMinutes: 1,
      },
    },
  };
}

type WatcherChild = EventEmitter & {
  pid: number;
  alive: boolean;
  stderr: PassThrough;
};

function exitChild(child: WatcherChild, code: number | null = 1, signal: string | null = null) {
  child.alive = false;
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
}

describe("runGmailService", () => {
  let children: WatcherChild[];
  let signalBaselines: Map<(typeof signals)[number], ReturnType<typeof process.rawListeners>>;

  function shutdownHandler(signal: (typeof signals)[number]) {
    const added = process
      .rawListeners(signal)
      .filter((fn) => !signalBaselines.get(signal)?.includes(fn));
    expect(added).toHaveLength(1);
    return () => added[0]!(signal);
  }

  function expectSignalsDetached() {
    for (const signal of signals) {
      expect(process.rawListeners(signal)).toEqual(signalBaselines.get(signal));
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    signalBaselines = new Map(signals.map((signal) => [signal, process.rawListeners(signal)]));
    children = [];
    mocks.ensureDependency.mockReset().mockResolvedValue(undefined);
    mocks.ensureTailscaleEndpoint.mockReset().mockResolvedValue(undefined);
    mocks.getRuntimeConfig.mockReturnValue(createGmailConfig());
    mocks.runCommandWithTimeout.mockReset().mockResolvedValue(commandSuccess);
    mocks.spawn.mockReset().mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 9000 + children.length,
        alive: true,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn((signal: string) => {
          queueMicrotask(() => exitChild(child, null, signal));
          return true;
        }),
      });
      children.push(child);
      return child;
    });
    mocks.killProcessTree.mockImplementation((pid: number) => {
      const child = children.find((candidate) => candidate.pid === pid);
      if (child?.alive) {
        queueMicrotask(() => exitChild(child, null, "SIGTERM"));
      }
    });
  });

  afterEach(async () => {
    try {
      const handler = process
        .rawListeners("SIGINT")
        .find((fn) => !signalBaselines.get("SIGINT")?.includes(fn));
      handler?.("SIGINT");
      await vi.advanceTimersByTimeAsync(10_000);
      await stopGmailWatcher();
      expectSignalsDetached();
      expect(children.filter((child) => child.alive)).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the foreground watcher after two sequential unexpected exits", async () => {
    const config = createGmailConfig();
    config.hooks.enabled = false;
    config.hooks.gmail.account = "";
    const originalConfig = structuredClone(config);
    mocks.getRuntimeConfig.mockReturnValue(config);
    await runGmailService({ account: "override@example.com", port: 9876, includeBody: false });
    expect(children).toHaveLength(1);
    for (let index = 0; index < 2; index++) {
      exitChild(children[index]!);
      // Both the old 2s loop and shared 5s lifecycle have had time to restart.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(children).toHaveLength(index + 2);
      expect(children.filter((child) => child.alive)).toHaveLength(1);
    }
    for (const [, args] of mocks.spawn.mock.calls) {
      expect(args).toEqual(
        expect.arrayContaining(["--account", "override@example.com", "--port", "9876"]),
      );
      expect(args).not.toContain("--include-body");
    }
    await vi.advanceTimersByTimeAsync(50_000);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(mocks.runCommandWithTimeout.mock.calls[1]?.[0]).toContain("override@example.com");
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(config).toEqual(originalConfig);
  });

  it("continues periodic renewal after a rejected command", async () => {
    mocks.runCommandWithTimeout
      .mockResolvedValueOnce(commandSuccess)
      .mockRejectedValueOnce(new Error("renewal failed"));
    await runGmailService({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(3);
    expect(children.filter((child) => child.alive)).toHaveLength(1);
  });

  it("logs bounded registration failures and keeps serving and renewing", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 124,
      signal: "SIGTERM",
      killed: true,
      termination: "timeout",
      stdout: `${"x".repeat(30_000)}\nregistration stdout tail`,
      stderr: `${"noise\n".repeat(1000)}\u001b[31mregistration stderr tail\u001b[0m`,
    });
    await runGmailService({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children.filter((child) => child.alive)).toHaveLength(1);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(3);
    expect(mocks.log.error).toHaveBeenCalledTimes(3);
    for (const [message] of mocks.log.error.mock.calls) {
      expect(message.length).toBeLessThan(2000);
      expect(message).toContain("gog gmail watch start failed");
      expect(message).toContain("registration stdout tail");
      expect(message).toContain("registration stderr tail");
      expect(message).toContain("termination=timeout");
      expect(message).toContain("code=124");
      expect(message).toContain("signal=SIGTERM");
      expect(message).not.toContain("\u001b");
    }
  });

  it("keeps renewal single-flight and cancels it on shutdown", async () => {
    const renewal = createDeferred<typeof commandSuccess>();
    let renewalSignal: AbortSignal | undefined;
    mocks.runCommandWithTimeout
      .mockResolvedValueOnce(commandSuccess)
      .mockImplementationOnce((_args, options: { signal: AbortSignal }) => {
        renewalSignal = options.signal;
        options.signal.addEventListener("abort", () => renewal.resolve(commandSuccess), {
          once: true,
        });
        return renewal.promise;
      });
    await runGmailService({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
    shutdownHandler("SIGTERM")();
    expect(renewalSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
    expect(children[0]?.alive).toBe(false);
    expectSignalsDetached();
  });

  it.each(
    signals.flatMap((signal) =>
      ["replacement", "restart delay"].map((phase) => ({ signal, phase })),
    ),
  )(
    "$signal stops the watcher during $phase without restarting or renewing",
    async ({ signal, phase }) => {
      await runGmailService({});
      exitChild(children[0]!);
      await vi.advanceTimersByTimeAsync(phase === "replacement" ? 5_000 : 1_000);
      const countAtShutdown = children.length;
      const shutdown = shutdownHandler(signal);
      shutdown();
      shutdown();
      shutdownHandler(signal === "SIGINT" ? "SIGTERM" : "SIGINT")();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(children).toHaveLength(countAtShutdown);
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
      expect(mocks.killProcessTree).toHaveBeenCalledTimes(
        (process.platform === "win32" ? 0 : 1) + (phase === "replacement" ? 1 : 0),
      );
      if (phase === "replacement") {
        expect(mocks.killProcessTree).toHaveBeenCalledWith(
          children[1]!.pid,
          expect.objectContaining({ graceMs: 3_000 }),
        );
        expect(children[1]?.alive).toBe(false);
      }
      expectSignalsDetached();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(
    signals.flatMap((signal) => ["tailscale", "watch"].map((boundary) => ({ signal, boundary }))),
  )(
    "$signal cancels in-flight $boundary startup without a late child",
    async ({ signal, boundary }) => {
      const pending = createDeferred<typeof commandSuccess>();
      let startupSignal: AbortSignal | undefined;
      if (boundary === "tailscale") {
        mocks.ensureTailscaleEndpoint.mockImplementation((options: { signal: AbortSignal }) => {
          startupSignal = options.signal;
          return pending.promise;
        });
      } else {
        mocks.runCommandWithTimeout.mockImplementation(
          (_args, options: { signal: AbortSignal }) => {
            startupSignal = options.signal;
            return pending.promise;
          },
        );
      }
      const starting = runGmailService({ tailscale: boundary === "tailscale" ? "serve" : "off" });
      await vi.advanceTimersByTimeAsync(0);
      expect(startupSignal).toBeDefined();
      shutdownHandler(signal)();
      expect(startupSignal?.aborted).toBe(true);
      // The boundary deliberately settles late, even after cancellation.
      pending.resolve(commandSuccess);
      await starting;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(children).toHaveLength(0);
      expectSignalsDetached();
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(boundary === "tailscale" ? 0 : 1);
    },
  );

  it.each(["tailscale", "spawn"])(
    "cleans up signals after %s startup failure",
    async (boundary) => {
      if (boundary === "tailscale") {
        mocks.ensureTailscaleEndpoint.mockRejectedValueOnce(new Error("fixture setup failed"));
      } else {
        mocks.spawn.mockImplementationOnce(() => {
          throw new Error("fixture setup failed");
        });
      }
      await expect(
        runGmailService({ tailscale: boundary === "tailscale" ? "serve" : "off" }),
      ).rejects.toThrow("fixture setup failed");
      expect(children).toHaveLength(0);
      expectSignalsDetached();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["initial", "replacement"])(
    "halts restarts after a split bind error on the %s child",
    async (phase) => {
      await runGmailService({});
      if (phase === "replacement") {
        exitChild(children[0]!);
        await vi.advanceTimersByTimeAsync(5_000);
      }
      const countBeforeBind = children.length;
      const child = children.at(-1)!;
      child.stderr.emit("data", Buffer.from("address alre"));
      child.alive = false;
      child.emit("exit", 1, null);
      child.stderr.emit("data", Buffer.from("ady in use\n"));
      child.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(children).toHaveLength(countBeforeBind);
      expect(children.filter((candidate) => candidate.alive)).toHaveLength(0);
      // Another watcher can own forwarding, so watch renewal must remain active.
      expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
    },
  );
});
