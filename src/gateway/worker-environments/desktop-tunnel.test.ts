import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerDesktopEndpoint, WorkerSshEndpoint } from "../../plugins/types.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { createWorkerDesktopTunnels } from "./desktop-tunnel.js";
import type { WorkerSshProcess, WorkerSshRunner } from "./tunnel-ssh-runner.js";

const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  user: "worker",
  hostKey: "ssh-ed25519 AAAA",
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};
const DESKTOP: WorkerDesktopEndpoint = {
  protocol: "rfb",
  port: 5900,
  passwordFilePath: "/var/lib/crabbox/vnc.password",
};
const resolveIdentity = async () => ({ kind: "path", path: "/keys/worker" }) as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

class FakeProcess implements WorkerSshProcess {
  private readonly readyDeferred = deferred<void>();
  private readonly exitDeferred = deferred<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  readonly ready = this.readyDeferred.promise;
  readonly exited = this.exitDeferred.promise;
  stopCount = 0;
  private stopPromise?: Promise<void>;

  becomeReady() {
    this.readyDeferred.resolve();
  }

  exit() {
    this.exitDeferred.resolve({ code: 1, signal: null });
  }

  stop() {
    return (this.stopPromise ??= Promise.resolve().then(() => {
      this.stopCount += 1;
      this.readyDeferred.reject(new Error("stopped"));
      this.exitDeferred.resolve({ code: null, signal: "SIGTERM" });
    }));
  }
}

function success(stdout = ""): SpawnResult {
  return {
    stdout,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function fakeRunner(
  onRun?: (argv: string[], options: CommandOptions) => Promise<SpawnResult> | SpawnResult,
) {
  const starts: Array<{ argv: string[]; options: CommandOptions; process: FakeProcess }> = [];
  const runs: Array<{ argv: string[]; options: CommandOptions }> = [];
  const runner: WorkerSshRunner = {
    start(argv, options) {
      const process = new FakeProcess();
      starts.push({ argv, options, process });
      return process;
    },
    async run(argv, options) {
      runs.push({ argv, options });
      return (await onRun?.(argv, options)) ?? success("vnc-secret\n");
    },
  };
  return { runner, runs, starts };
}

function launchApp(
  manager: ReturnType<typeof createWorkerDesktopTunnels>,
  app: "browser" | "terminal" = "browser",
  ownerEpoch = 1,
  ssh = SSH,
) {
  return manager.launchApp({
    environmentId: "worker:one",
    ownerEpoch,
    ssh,
    app:
      app === "browser"
        ? {
            id: "browser",
            executablePath: "/usr/local/bin/openclaw-worker-browser",
            cdpPort: 9222,
          }
        : { id: "terminal", executablePath: "/usr/local/bin/openclaw-worker-terminal" },
    resolveIdentity,
  });
}

function acquire(
  manager: ReturnType<typeof createWorkerDesktopTunnels>,
  ownerEpoch = 1,
  desktop = DESKTOP,
) {
  return manager.acquire({
    environmentId: "worker:one",
    ownerEpoch,
    ssh: SSH,
    desktop,
    resolveIdentity,
  });
}

async function waitForStarts(starts: unknown[], count: number) {
  await vi.waitFor(() => expect(starts).toHaveLength(count), { interval: 1 });
}

afterEach(() => vi.useRealTimers());

describe("worker desktop tunnels", () => {
  it("creates one pinned local forward per epoch and caches the password", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });
    const starting = acquire(manager);
    await waitForStarts(fake.starts, 1);
    const start = fake.starts[0]!;
    expect(start.argv).toContain("ClearAllForwardings=no");
    expect(start.argv).toContain("StreamLocalBindMask=0177");
    expect(start.argv).toContain("ServerAliveInterval=15");
    expect(start.argv).toContain("ServerAliveCountMax=3");
    expect(start.argv[start.argv.indexOf("-L") + 1]).toMatch(
      /openclaw-worker-desktop-.+\/desktop\.sock:127\.0\.0\.1:5900$/u,
    );
    expect(start.options.input).toContain("OPENCLAW_WORKER_TUNNEL_READY");
    start.process.becomeReady();
    const result = await starting;
    expect(result).toMatchObject({ vncPassword: "vnc-secret" });
    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0]?.argv.at(-1)).toContain("/var/lib/crabbox/vnc.password");

    await expect(acquire(manager)).resolves.toEqual(result);
    expect(fake.starts).toHaveLength(1);
    expect(fake.runs).toHaveLength(1);
    await manager.stopAll();
  });

  it("fences an older epoch before starting its replacement", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });
    const first = acquire(manager, 1, { protocol: "rfb", port: 5900 });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await first;

    const second = acquire(manager, 2, { protocol: "rfb", port: 5901 });
    await waitForStarts(fake.starts, 2);
    expect(fake.starts[0]?.process.stopCount).toBe(1);
    expect(fake.starts[1]?.argv[fake.starts[1]!.argv.indexOf("-L") + 1]).toContain(
      ":127.0.0.1:5901",
    );
    fake.starts[1]?.process.becomeReady();
    await second;
    await expect(acquire(manager, 1)).rejects.toThrow("owner epoch is stale");
    await manager.stopAll();
  });

  it("fences stop by owner epoch while allowing matching and unconditional teardown", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });
    const second = acquire(manager, 2, { protocol: "rfb", port: 5900 });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await second;

    await manager.stop("worker:one", 1);
    expect(fake.starts[0]?.process.stopCount).toBe(0);
    await manager.stop("worker:one", 2);
    expect(fake.starts[0]?.process.stopCount).toBe(1);

    const third = acquire(manager, 3, { protocol: "rfb", port: 5900 });
    await waitForStarts(fake.starts, 2);
    fake.starts[1]?.process.becomeReady();
    await third;
    await manager.stop("worker:one");
    expect(fake.starts[1]?.process.stopCount).toBe(1);
  });

  it("enforces controller takeover and the observer cap", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });
    const starting = acquire(manager, 1, { protocol: "rfb", port: 5900 });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await starting;

    const firstClose = vi.fn();
    const first = manager.attachObserver("worker:one", {
      control: true,
      ownerEpoch: 1,
      close: firstClose,
    });
    const second = manager.attachObserver("worker:one", {
      control: true,
      ownerEpoch: 1,
      close: vi.fn(),
    });
    expect(firstClose).toHaveBeenCalledWith(4000, "control-taken");
    first?.release();
    const observers = Array.from({ length: 7 }, () =>
      manager.attachObserver("worker:one", { control: false, ownerEpoch: 1, close: vi.fn() }),
    );
    expect(observers.every(Boolean)).toBe(true);
    expect(
      manager.attachObserver("worker:one", { control: false, ownerEpoch: 1, close: vi.fn() }),
    ).toBeUndefined();
    second?.release();
    observers.forEach((observer) => observer?.release());
    await manager.stopAll();
  });

  it("lingers after the last observer and closes observers on child exit", async () => {
    vi.useFakeTimers();
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner, lingerMs: 50 });
    const starting = acquire(manager, 1, { protocol: "rfb", port: 5900 });
    await vi.waitFor(() => expect(fake.starts).toHaveLength(1));
    fake.starts[0]?.process.becomeReady();
    await starting;
    const close = vi.fn();
    const observer = manager.attachObserver("worker:one", { control: false, ownerEpoch: 1, close });
    observer?.release();
    await vi.advanceTimersByTimeAsync(49);
    expect(fake.starts[0]?.process.stopCount).toBe(0);
    const replacement = manager.attachObserver("worker:one", {
      control: false,
      ownerEpoch: 1,
      close,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.starts[0]?.process.stopCount).toBe(0);
    fake.starts[0]?.process.exit();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(1012, "desktop tunnel closed"));
    replacement?.release();
  });

  it("refuses observer tokens minted against a replaced owner epoch", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });
    const first = acquire(manager, 1);
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await first;

    const second = acquire(manager, 2);
    await waitForStarts(fake.starts, 2);
    fake.starts[1]?.process.becomeReady();
    await second;

    const controllerClose = vi.fn();
    const controller = manager.attachObserver("worker:one", {
      control: true,
      ownerEpoch: 2,
      close: controllerClose,
    });
    expect(controller).toBeDefined();

    // A stale control token must not reach the replacement entry or evict its controller.
    expect(
      manager.attachObserver("worker:one", { control: true, ownerEpoch: 1, close: vi.fn() }),
    ).toBeUndefined();
    expect(controllerClose).not.toHaveBeenCalled();

    controller?.release();
    await manager.stopAll();
  });

  it("rejects Windows gateway hosts before spawning SSH", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner, platform: "win32" });
    await expect(acquire(manager)).rejects.toMatchObject({ code: "unsupported_platform" });
    await expect(acquire(manager)).rejects.toThrow(
      "desktop observe is not supported on Windows gateway hosts",
    );
    expect(fake.starts).toEqual([]);
  });

  it("deduplicates one exact no-argument launcher command per app and epoch", async () => {
    const result = deferred<SpawnResult>();
    const fake = fakeRunner(async () => await result.promise);
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });

    const first = launchApp(manager);
    const second = launchApp(manager);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1), { interval: 1 });
    const run = fake.runs[0]!;
    expect(run.argv.at(-1)).toBe("'/usr/local/bin/openclaw-worker-browser'");
    expect(run.argv.at(-1)).not.toContain("9222");
    expect(run.argv.at(-1)).not.toContain(".cache/openclaw");
    expect(run.options.timeoutMs).toBeGreaterThan(0);
    expect(run.options.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(run.options.signal).toBeInstanceOf(AbortSignal);
    result.resolve(success());

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await manager.stopAll();
  });

  it.each(["browser", "terminal"] as const)(
    "does not replay a %s launch after ambiguous SSH exit 255",
    async (app) => {
      const fake = fakeRunner(() => ({
        ...success(),
        code: 255,
        stderr: "connection lost after remote acceptance",
      }));
      const manager = createWorkerDesktopTunnels({ runner: fake.runner });

      await expect(launchApp(manager, app, 1, { ...SSH, fallbackPorts: [2203] })).rejects.toThrow(
        "connection lost after remote acceptance",
      );
      expect(fake.runs.map(({ argv }) => argv[argv.indexOf("-p") + 1])).toEqual(["2202"]);
      await manager.stopAll();
    },
  );

  it("aborts pending launchers on matching teardown and fences stale epochs", async () => {
    const signals: AbortSignal[] = [];
    const fake = fakeRunner(
      async (_argv, options) =>
        await new Promise<SpawnResult>((_resolve, reject) => {
          const signal = options.signal;
          if (!signal) {
            reject(new Error("missing launcher abort signal"));
            return;
          }
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("launcher aborted", { cause: signal.reason }),
              ),
            { once: true },
          );
        }),
    );
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });
    const launching = launchApp(manager);
    await vi.waitFor(() => expect(fake.runs).toHaveLength(1), { interval: 1 });

    await manager.stop("worker:one", 1);
    await expect(launching).rejects.toThrow("owner stopped");
    expect(signals[0]?.aborted).toBe(true);
    await expect(launchApp(manager, "browser", 0)).rejects.toThrow("owner epoch is stale");
  });

  it("publishes launcher ownership before immediate teardown can observe it", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });

    const launching = launchApp(manager);
    const stopping = manager.stop("worker:one", 1);

    await expect(launching).rejects.toThrow("owner stopped");
    await stopping;
    expect(fake.runs).toEqual([]);
  });

  it("reports unsupported launcher platforms and nonzero launcher exits", async () => {
    const unsupported = createWorkerDesktopTunnels({
      runner: fakeRunner().runner,
      platform: "win32",
    });
    await expect(launchApp(unsupported)).rejects.toMatchObject({ code: "unsupported_platform" });
    await expect(launchApp(unsupported)).rejects.toThrow(
      "desktop app launch is not supported on Windows gateway hosts",
    );

    const failed = createWorkerDesktopTunnels({
      runner: fakeRunner(() => ({ ...success(), code: 7, stderr: "launcher failed" })).runner,
    });
    await expect(launchApp(failed)).rejects.toThrow("launcher failed");
    await failed.stopAll();
  });

  it("keeps a same-epoch desktop session alive when an app launch fences replaced owners", async () => {
    const fake = fakeRunner();
    const manager = createWorkerDesktopTunnels({ runner: fake.runner });
    // The launcher claims the epoch first, so its fencing pass runs after the
    // observer session for that same epoch already exists. Fencing must only
    // retire strictly older owners; equal epochs share the session.
    const launching = launchApp(manager, "browser", 1);
    const starting = acquire(manager, 1);
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await starting;
    await launching;

    const observer = manager.attachObserver("worker:one", {
      control: false,
      ownerEpoch: 1,
      close: vi.fn(),
    });
    expect(observer).toBeDefined();
    observer?.release();
  });
});
