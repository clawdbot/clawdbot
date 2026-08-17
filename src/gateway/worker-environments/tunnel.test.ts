import { describe, expect, it, vi } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { parseWorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { createWorkerSshRunner } from "./tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import {
  BUNDLE_HASH,
  PWD_COMMAND,
  SSH,
  deferred,
  fakeRunner,
  resolveIdentity,
  startConnectedTunnel,
  startTestTunnel,
  success,
  waitForFast,
  waitForStarts,
} from "./tunnel.test-support.js";
import { sshArgvPort } from "./worker-ssh-argv.test-support.js";

describe("worker tunnel manager", () => {
  it("cascades only an epoch-matched environment stop into the desktop tunnel owner", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.desktop.acquire({
      environmentId: "worker:desktop-cascade",
      ownerEpoch: 2,
      ssh: SSH,
      desktop: { protocol: "rfb", port: 5900 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await starting;
    const close = vi.fn();
    manager.desktop.attachObserver("worker:desktop-cascade", {
      control: false,
      ownerEpoch: 2,
      close,
    });

    await manager.stop("worker:desktop-cascade", 1);

    expect(fake.starts[0]?.process.stopCount).toBe(0);
    expect(close).not.toHaveBeenCalled();

    await manager.stop("worker:desktop-cascade", 2);

    expect(fake.starts[0]?.process.stopCount).toBe(1);
    expect(close).toHaveBeenCalledWith(1012, "desktop tunnel closed");
  });

  it("establishes a pinned reverse socket with keepalives and a separate workspace connection", async () => {
    const fake = fakeRunner();
    const { manager, handle, start: tunnel } = await startConnectedTunnel(fake, "worker:one", 3);
    expect(tunnel?.argv).toContain("ClearAllForwardings=no");
    expect(tunnel?.argv).toContain("ServerAliveInterval=15");
    expect(tunnel?.argv).toContain("ServerAliveCountMax=3");
    expect(tunnel?.argv).toContain("StreamLocalBindMask=0177");
    expect(tunnel?.argv).toContain("StreamLocalBindUnlink=yes");
    expect(tunnel?.options.input).not.toContain("rm -f");
    expect(tunnel?.options.input).toContain("sleep 15; printf '.'");
    expect(tunnel?.options.input).toContain("remote command received SIGHUP");
    expect(tunnel?.argv[tunnel.argv.indexOf("-R") + 1]).toMatch(
      /^\/tmp\/ocw-[a-f0-9]{16}-3\/gateway\.sock:127\.0\.0\.1:18789$/u,
    );
    expect(manager.status("worker:one")).toBe("connected");
    await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
    const workspace = fake.runs.at(-1);
    expect(workspace?.argv).toContain("ClearAllForwardings=yes");
    expect(workspace?.argv).toContain("ControlMaster=no");
    expect(workspace?.argv).toContain("ControlPath=none");
    expect(workspace?.argv.at(-1)).toContain("pwd");
    expect(fake.starts).toHaveLength(1);
    const plan = parseWorkerLaunchPlan({
      version: 3,
      admission: {
        environmentId: "worker:one",
        credential: "worker-credential-fixture",
        sessionId: "session-1",
        ownerEpoch: 3,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        handshake: {
          bundleHash: BUNDLE_HASH,
          openclawVersion: "2026.8.13",
          protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
        },
      },
      assignment: {
        agentId: "main",
        operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
        agentRuntimeIdentityToken: "runtime-token",
        runId: "run-1",
        turnId: "turn-1",
        prompt: "inspect",
        suppressPromptTranscript: true,
        workspaceDir: "/worker/workspace",
        modelRef: { provider: "openai", model: "gpt-5.6-luna" },
        inferenceOptions: {},
        initialMessages: [],
        transcript: { baseLeafId: null, nextSeq: 1 },
        liveEvents: { ackedSeq: 0, nextSeq: 1 },
        toolAuthority: { allowedToolNames: [] },
      },
    });
    const onDispatchReady = vi.fn();
    await expect(
      handle.launchTurn({
        plan,
        turnClaim: {
          sessionId: plan.admission.sessionId,
          claimId: "claim-1",
          runId: plan.assignment.runId,
          placementGeneration: 1,
          owner: {
            kind: "worker",
            environmentId: plan.admission.environmentId,
            ownerEpoch: plan.admission.ownerEpoch,
          },
        },
        timeoutMs: 123,
        onDispatchReady,
      }),
    ).resolves.toEqual(success());
    expect(onDispatchReady).toHaveBeenCalledOnce();
    const launch = fake.runs.at(-1);
    const remoteLaunchCommand = launch?.argv.at(-1) ?? "";
    expect(remoteLaunchCommand).toContain("'sh' '-c'");
    expect(remoteLaunchCommand).toContain('exec node "$HOME/.openclaw-worker/$1/worker.mjs"');
    expect(remoteLaunchCommand).toContain(`'${BUNDLE_HASH}'`);
    expect(launch?.options.input).toContain('"connectionEndpoint":{"kind":"unix"');
    expect(launch?.options.timeoutMs).toBeGreaterThan(0);
    expect(launch?.options.timeoutMs).toBeLessThanOrEqual(123);
    await handle.stop();
    expect(tunnel?.process.stopCount).toBe(1);
    expect(manager.status("worker:one")).toBe("stopped");
  });

  it("renews a workspace quiescence lease while reconciliation is still running", async () => {
    const nonce = "a".repeat(32);
    const fake = fakeRunner((argv) => {
      const remoteCommand = argv.at(-1) ?? "";
      if (remoteCommand.includes('process.stdout.write("quiesced "')) {
        return success(`quiesced ${nonce}\n`);
      }
      if (remoteCommand.includes('process.stdout.write("renewed "')) {
        return success(`renewed ${nonce}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:quiescence-renewal", 3);

    vi.useFakeTimers();
    try {
      const quiescence = await handle.quiesceWorkspace("/home/worker/workspace");
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(
        fake.runs.filter((entry) => entry.argv.at(-1)?.includes('process.stdout.write("renewed "')),
      ).toHaveLength(1);
      await quiescence.resume();
    } finally {
      vi.useRealTimers();
      await handle.stop();
    }
  });

  it("passes shared-host isolation to initial and renewal quiescence commands", async () => {
    const nonce = "b".repeat(32);
    const fake = fakeRunner((argv) => {
      const remoteCommand = argv.at(-1) ?? "";
      if (remoteCommand.includes('process.stdout.write("quiesced "')) {
        return success(`quiesced ${nonce}\n`);
      }
      if (remoteCommand.includes('process.stdout.write("renewed "')) {
        return success(`renewed ${nonce}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:shared-quiescence", 3, {
      sharedHost: true,
    });

    const quiescence = await handle.quiesceWorkspace("/home/worker/workspace");
    await quiescence.assertActive();
    const quiescenceCommands = fake.runs.filter((entry) =>
      entry.argv.at(-1)?.includes("workspace quiescence"),
    );
    expect(quiescenceCommands).toHaveLength(2);
    expect(quiescenceCommands.every((entry) => entry.argv.at(-1)?.includes("shared-host"))).toBe(
      true,
    );
    await quiescence.resume();
    await handle.stop();
  });

  it("reconnects with capped backoff after unexpected exits and failed attempts", async () => {
    const fake = fakeRunner();
    const delays: number[] = [];
    const { manager, handle } = await startConnectedTunnel(fake, "worker:retry", 1, {
      manager: {
        backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });

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

  it("reports stopped when the reconnect loop settles without removing its entry", async () => {
    const fake = fakeRunner();
    const { manager, handle } = await startConnectedTunnel(fake, "worker:settled-loop", 1, {
      manager: {
        sleep: async () => {
          throw new Error("retry scheduler stopped");
        },
      },
    });

    fake.starts[0]?.process.exit();
    await waitForFast(() => expect(manager.status("worker:settled-loop")).toBe("stopped"));

    await handle.stop();
  });

  it("times out a marker-less SSH child and retries", async () => {
    vi.useFakeTimers();
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner, sleep: async () => {} });
    const starting = startTestTunnel(manager, "worker:ready-timeout", 1);
    const rejected = expect(starting).rejects.toThrow("stopped before connecting");

    try {
      await waitForStarts(fake.starts, 1);
      await vi.advanceTimersByTimeAsync(60_000);
      await waitForStarts(fake.starts, 2);

      expect(fake.starts[0]?.process.stopCount).toBe(1);
      expect(manager.status("worker:ready-timeout")).toBe("reconnecting");
    } finally {
      await manager.stop("worker:ready-timeout");
      await rejected;
      vi.useRealTimers();
    }
  });

  it("reconnects on the next advertised port after SSH transport exit 255", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({
      runner: fake.runner,
      sleep: async () => {},
    });
    const request = {
      bundleHash: BUNDLE_HASH,
      environmentId: "worker:port-reconnect",
      ownerEpoch: 1,
      ssh: { ...SSH, port: 2222, fallbackPorts: [22] },
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    } as const;
    const starting = manager.start(request);
    await waitForStarts(fake.starts, 1);
    expect(sshArgvPort(fake.starts[0]!.argv)).toBe(2222);
    fake.starts[0]!.process.becomeReady();
    await starting;

    fake.starts[0]!.process.exit(255);
    await waitForStarts(fake.starts, 2);
    expect(sshArgvPort(fake.starts[1]!.argv)).toBe(22);
    expect(sshArgvPort(fake.runs.at(-1)!.argv)).toBe(22);
    const reconnecting = manager.start(request);
    const reconnectSettled = vi.fn();
    void reconnecting.then(reconnectSettled, reconnectSettled);
    await Promise.resolve();
    await Promise.resolve();
    expect(reconnectSettled).not.toHaveBeenCalled();

    fake.starts[1]!.process.becomeReady();
    const handle = await reconnecting;
    await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
    expect(sshArgvPort(fake.runs.at(-1)!.argv)).toBe(22);
    await handle.stop();
  });

  it("waits before stateful dispatch and aborts reconnect waits on owner stop", async () => {
    const fake = fakeRunner();
    const sleepStarted = deferred<AbortSignal>();
    const { handle } = await startConnectedTunnel(fake, "worker:reconnect-command-policy", 1, {
      manager: {
        sleep: async (_ms, signal) => {
          if (!signal) {
            throw new Error("missing reconnect signal");
          }
          sleepStarted.resolve(signal);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("reconnect sleep aborted"),
                ),
              { once: true },
            );
          });
        },
      },
    });
    fake.starts[0]!.process.exit(255);
    await sleepStarted.promise;

    const idempotent = handle.runWorkspaceCommand(PWD_COMMAND);
    const idempotentResult = expect(idempotent).rejects.toThrow(
      "Worker tunnel owner is no longer connected",
    );
    const stateful = handle.runWorkspaceCommand({ ...PWD_COMMAND, transportRetry: "never" });
    const statefulSettled = vi.fn();
    void stateful.then(statefulSettled, statefulSettled);
    await Promise.resolve();
    await Promise.resolve();
    expect(statefulSettled).not.toHaveBeenCalled();

    await handle.stop();
    await idempotentResult;
    await expect(stateful).rejects.toThrow("Worker tunnel owner is no longer connected");
  });

  it("does not dispatch a stateful command cancelled during reconnect", async () => {
    const fake = fakeRunner();
    const releaseReconnect = deferred<void>();
    const { handle, manager } = await startConnectedTunnel(fake, "worker:cancel-reconnect", 1, {
      manager: {
        sleep: async () => await releaseReconnect.promise,
      },
    });
    const controller = new AbortController();
    const onDispatchReady = vi.fn();

    try {
      fake.starts[0]!.process.exit(255);
      await waitForFast(() =>
        expect(manager.status("worker:cancel-reconnect")).toBe("reconnecting"),
      );
      const command = handle.runWorkspaceCommand({
        ...PWD_COMMAND,
        transportRetry: "never",
        signal: controller.signal,
        onDispatchReady,
      });
      const settled = vi.fn();
      void command.then(settled, settled);

      controller.abort(new Error("turn cancelled"));
      await waitForFast(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 100 });
      await expect(command).rejects.toThrow("turn cancelled");

      releaseReconnect.resolve();
      await waitForStarts(fake.starts, 2);
      fake.starts[1]!.process.becomeReady();
      await Promise.resolve();
      await Promise.resolve();
      expect(onDispatchReady).not.toHaveBeenCalled();
      expect(fake.runs.filter((run) => run.argv.at(-1)?.includes("'pwd'"))).toHaveLength(0);
    } finally {
      releaseReconnect.resolve();
      await handle.stop();
    }
  });

  it("does not replay a stateful command after an ambiguous transport exit", async () => {
    const fake = fakeRunner((argv) =>
      argv.at(-1)?.includes("'pwd'") ? { ...success(), code: 255 } : undefined,
    );
    const { handle } = await startConnectedTunnel(fake, "worker:stateful-no-replay", 1, {
      ssh: { ...SSH, port: 2222, fallbackPorts: [22] },
    });

    try {
      await expect(
        handle.runWorkspaceCommand({ ...PWD_COMMAND, transportRetry: "never" }),
      ).resolves.toMatchObject({ code: 255 });
      expect(fake.runs.filter((run) => run.argv.at(-1)?.includes("'pwd'"))).toHaveLength(1);
    } finally {
      await handle.stop();
    }
  });

  it("shares setup and best-effort stop cleanup deadlines across fallback candidates", async () => {
    let nowMs = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const setupAttempts: Array<{ port: number; timeoutMs: number }> = [];
    const cleanupAttempts: Array<{ port: number; timeoutMs: number }> = [];
    const fake = fakeRunner((argv, options) => {
      const port = sshArgvPort(argv);
      if (port === undefined) {
        throw new Error("missing tunnel SSH port");
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker tunnel directory")
      ) {
        const timeoutMs = options.timeoutMs;
        if (timeoutMs === undefined) {
          throw new Error("missing tunnel setup timeout");
        }
        setupAttempts.push({ port, timeoutMs });
        if (setupAttempts.length === 1) {
          nowMs += 7_000;
          return { ...success("", "primary transport unavailable"), code: 255 };
        }
        return success();
      }
      if (typeof options.input === "string" && options.input.includes('rmdir -- "$directory"')) {
        const timeoutMs = options.timeoutMs;
        if (timeoutMs === undefined) {
          throw new Error("missing tunnel cleanup timeout");
        }
        cleanupAttempts.push({ port, timeoutMs });
        if (cleanupAttempts.length === 1) {
          nowMs += 5_000;
          return { ...success("", "selected transport unavailable"), code: 255 };
        }
        return success();
      }
      return undefined;
    });
    const manager = createWorkerTunnelManager({ runner: fake.runner, sleep: async () => {} });
    try {
      const starting = startTestTunnel(manager, "worker:operation-deadline", 1, {
        ...SSH,
        port: 2222,
        fallbackPorts: [22],
      });
      await waitForStarts(fake.starts, 1);
      expect(sshArgvPort(fake.starts[0]!.argv)).toBe(22);
      fake.starts[0]!.process.becomeReady();
      const handle = await starting;

      fake.starts[0]!.process.exit();
      await waitForStarts(fake.starts, 2);
      expect(sshArgvPort(fake.starts[1]!.argv)).toBe(22);
      fake.starts[1]!.process.becomeReady();
      await handle.stop();
      expect(setupAttempts).toEqual([
        { port: 2222, timeoutMs: 20_000 },
        { port: 22, timeoutMs: 13_000 },
        { port: 22, timeoutMs: 20_000 },
      ]);
      expect(cleanupAttempts).toEqual([
        { port: 22, timeoutMs: 20_000 },
        { port: 2222, timeoutMs: 15_000 },
      ]);
      expect(manager.status("worker:operation-deadline")).toBe("stopped");
    } finally {
      dateNow.mockRestore();
      await manager.stopAll();
    }
  });

  it("backs off repeated short-lived connected tunnels", async () => {
    const fake = fakeRunner();
    const delays: number[] = [];
    const { handle } = await startConnectedTunnel(fake, "worker:flap", 1, {
      manager: {
        backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });

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
    const { manager, handle } = await startConnectedTunnel(fake, "worker:drain", 8, {
      manager: {
        sleep: async (_ms, signal) => {
          if (!signal) {
            throw new Error("missing reconnect signal");
          }
          sleepStarted.resolve(signal);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
    });
    fake.starts[0]?.process.exit();
    await sleepStarted.promise;

    const reconnecting = manager.start({
      bundleHash: BUNDLE_HASH,
      environmentId: "worker:drain",
      ownerEpoch: 8,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    const reconnectResult = expect(reconnecting).rejects.toThrow("stopped before connecting");
    await handle.stop();
    await reconnectResult;
    expect(manager.status("worker:drain")).toBe("stopped");
    expect(fake.starts).toHaveLength(1);

    const pending = startTestTunnel(manager, "worker:late", 1);
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
    const { manager, handle } = await startConnectedTunnel(fake, "worker:epoch", 4);

    await expect(startTestTunnel(manager, "worker:epoch", 3)).rejects.toThrow("epoch is stale");
    expect(fake.starts).toHaveLength(1);
    await handle.stop();
  });

  it("publishes a replacement epoch before awaiting prior teardown", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner, sleep: async () => {} });
    const initialRequest = {
      bundleHash: BUNDLE_HASH,
      environmentId: "worker:replacement",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    } as const;
    const current = manager.start(initialRequest);
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await current;

    fake.starts[0]?.process.exit();
    await waitForStarts(fake.starts, 2);
    const staleReconnect = fake.starts[1]!.process;
    const staleOwnerStart = manager.start(initialRequest);
    const staleOwnerResult = expect(staleOwnerStart).rejects.toThrow("stopped before connecting");
    const releaseStop = deferred<void>();
    staleReconnect.blockStopUntil(releaseStop.promise);
    const replacement = manager.start({
      bundleHash: BUNDLE_HASH,
      environmentId: "worker:replacement",
      ownerEpoch: 2,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    const replacementSettled = vi.fn();
    void replacement.then(replacementSettled, replacementSettled);
    await waitForFast(() => expect(staleReconnect.stopCount).toBeGreaterThan(0));
    await staleOwnerResult;

    staleReconnect.becomeReady();
    await Promise.resolve();
    await Promise.resolve();
    expect(replacementSettled).not.toHaveBeenCalled();
    releaseStop.resolve();
    await waitForStarts(fake.starts, 3);
    expect(replacementSettled).not.toHaveBeenCalled();
    fake.starts[2]!.process.becomeReady();
    const handle = await replacement;

    expect(handle.ownerEpoch).toBe(2);
    expect(manager.status("worker:replacement")).toBe("connected");
    await handle.stop();
  });
});

describe("createWorkerSshRunner diagnostic tails", () => {
  it("keeps SSH tunnel failure stderr on a valid UTF-16 boundary", async () => {
    const retained = "b".repeat(4095);
    const child = createWorkerSshRunner().start(
      [process.execPath, "-e", `process.stderr.write(${JSON.stringify(`a😀${retained}`)})`],
      { timeoutMs: 10_000, baseEnv: process.env },
    );

    await expect(child.ready).rejects.toThrow(`Worker SSH tunnel failed: ${retained}`);
    await child.exited;
  });
});
