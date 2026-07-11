import { describe, expect, it, vi } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import {
  createWorkerTunnelManager,
  type WorkerSshProcess,
  type WorkerSshProcessExit,
  type WorkerSshRunner,
} from "./tunnel.js";

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};

function success(): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

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
  private readonly exitDeferred = deferred<WorkerSshProcessExit>();
  readonly ready = this.readyDeferred.promise;
  readonly exited = this.exitDeferred.promise;
  stopCount = 0;
  private stopBarrier: Promise<void> | undefined;

  becomeReady() {
    this.readyDeferred.resolve();
  }

  failReady(message = "connect failed") {
    this.readyDeferred.reject(new Error(message));
  }

  exit() {
    this.exitDeferred.resolve({ code: 1, signal: null });
  }

  blockStopUntil(barrier: Promise<void>) {
    this.stopBarrier = barrier;
  }

  async stop() {
    this.stopCount += 1;
    await this.stopBarrier;
    this.readyDeferred.reject(new Error("stopped"));
    this.exitDeferred.resolve({ code: null, signal: "SIGTERM" });
  }
}

function fakeRunner() {
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
      return success();
    },
  };
  return { runner, runs, starts };
}

const resolveIdentity = async () => ({ kind: "path", path: "/keys/worker" }) as const;

async function waitForStarts(starts: unknown[], count: number) {
  await vi.waitFor(() => expect(starts).toHaveLength(count));
}

describe("worker tunnel manager", () => {
  it("establishes a pinned reverse socket with keepalives and a separate workspace connection", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:one",
      ownerEpoch: 3,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });

    await waitForStarts(fake.starts, 1);
    const tunnel = fake.starts[0];
    expect(tunnel?.argv).toContain("ClearAllForwardings=no");
    expect(tunnel?.argv).toContain("ServerAliveInterval=15");
    expect(tunnel?.argv).toContain("ServerAliveCountMax=3");
    expect(tunnel?.argv).toContain("StreamLocalBindMask=0177");
    expect(tunnel?.argv).toContain("StreamLocalBindUnlink=yes");
    expect(tunnel?.options.input).not.toContain("rm -f");
    expect(tunnel?.argv[tunnel.argv.indexOf("-R") + 1]).toMatch(
      /^\/tmp\/ocw-[a-f0-9]+\/gateway\.sock:127\.0\.0\.1:18789$/u,
    );
    tunnel?.process.becomeReady();
    const handle = await starting;
    expect(manager.status("worker:one")).toBe("connected");

    await expect(handle.runWorkspaceCommand({ argv: ["pwd"] })).resolves.toEqual(success());
    const workspace = fake.runs.at(-1);
    expect(workspace?.argv).toContain("ClearAllForwardings=yes");
    expect(workspace?.argv).toContain("ControlMaster=no");
    expect(workspace?.argv).toContain("ControlPath=none");
    expect(workspace?.argv.at(-1)).toContain("pwd");
    expect(fake.starts).toHaveLength(1);

    await handle.stop();
    expect(tunnel?.process.stopCount).toBe(1);
    expect(manager.status("worker:one")).toBe("stopped");
  });

  it("reconnects with capped backoff after unexpected exits and failed attempts", async () => {
    const fake = fakeRunner();
    const delays: number[] = [];
    const manager = createWorkerTunnelManager({
      runner: fake.runner,
      backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const starting = manager.start({
      environmentId: "worker:retry",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

    fake.starts[0]?.process.exit();
    await waitForStarts(fake.starts, 2);
    fake.starts[1]?.process.failReady();
    await waitForStarts(fake.starts, 3);
    fake.starts[2]?.process.failReady();
    await waitForStarts(fake.starts, 4);

    expect(delays).toEqual([5, 10, 10]);
    expect(manager.status("worker:retry")).toBe("reconnecting");
    await handle.stop();
  });

  it("backs off repeated short-lived connected tunnels", async () => {
    const fake = fakeRunner();
    const delays: number[] = [];
    const manager = createWorkerTunnelManager({
      runner: fake.runner,
      backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const starting = manager.start({
      environmentId: "worker:flap",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

    for (let index = 0; index < 3; index += 1) {
      fake.starts[index]?.process.exit();
      await waitForStarts(fake.starts, index + 2);
      fake.starts[index + 1]?.process.becomeReady();
    }

    expect(delays).toEqual([5, 10, 10]);
    await handle.stop();
  });

  it("fences reconnect before teardown and ignores a late process readiness signal", async () => {
    const fake = fakeRunner();
    const sleepStarted = deferred<AbortSignal>();
    const manager = createWorkerTunnelManager({
      runner: fake.runner,
      sleep: async (_ms, signal) => {
        if (!signal) {
          throw new Error("missing reconnect signal");
        }
        sleepStarted.resolve(signal);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const starting = manager.start({
      environmentId: "worker:drain",
      ownerEpoch: 8,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;
    fake.starts[0]?.process.exit();
    await sleepStarted.promise;

    await handle.stop();
    expect(manager.status("worker:drain")).toBe("stopped");
    expect(fake.starts).toHaveLength(1);

    const pending = manager.start({
      environmentId: "worker:late",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    const pendingResult = expect(pending).rejects.toThrow("stopped before connecting");
    await waitForStarts(fake.starts, 2);
    const late = fake.starts[1]?.process;
    const stopping = manager.stop("worker:late");
    late?.becomeReady();
    await stopping;
    await pendingResult;
    expect(fake.starts).toHaveLength(2);
  });

  it("rejects stale owner epochs without replacing the current tunnel", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const current = manager.start({
      environmentId: "worker:epoch",
      ownerEpoch: 4,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await current;

    await expect(
      manager.start({
        environmentId: "worker:epoch",
        ownerEpoch: 3,
        ssh: SSH,
        gateway: { host: "127.0.0.1", port: 18789 },
        resolveIdentity,
      }),
    ).rejects.toThrow("epoch is stale");
    expect(fake.starts).toHaveLength(1);
    await handle.stop();
  });

  it("publishes a replacement epoch before awaiting prior teardown", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const current = manager.start({
      environmentId: "worker:replacement",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await current;

    const releaseStop = deferred<void>();
    fake.starts[0]?.process.blockStopUntil(releaseStop.promise);
    const replacement = manager.start({
      environmentId: "worker:replacement",
      ownerEpoch: 2,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    const rejectedReplacement = expect(replacement).rejects.toThrow("stopped before connecting");
    await vi.waitFor(() => expect(fake.starts[0]?.process.stopCount).toBe(1));

    const stopping = manager.stop("worker:replacement");
    releaseStop.resolve();
    await stopping;
    await rejectedReplacement;

    expect(manager.status("worker:replacement")).toBe("stopped");
    expect(fake.starts).toHaveLength(1);
  });
});
