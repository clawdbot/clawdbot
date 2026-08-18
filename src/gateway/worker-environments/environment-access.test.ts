import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("projects live tunnel status and fences the tunnel before provider teardown", async () => {
    support.seedReady("worker-tunnel", undefined, true);
    const order: string[] = [];
    let tunnelStatus: "stopped" | "connected" = "stopped";
    const tunnelManager = {
      status: () => tunnelStatus,
      start: vi.fn(async (request) => {
        tunnelStatus = "connected";
        return {
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          launchTurn: vi.fn(),
          runWorkspaceCommand: vi.fn(),
          syncWorkspace: vi.fn(),
          stop: async () => {},
        };
      }),
      stop: vi.fn(async () => {
        tunnelStatus = "stopped";
        order.push("tunnel-stop");
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = support.createService(provider, { tunnelManager });

    await expect(
      workerService.startTunnel({ environmentId: "worker-tunnel", ownerEpoch: 0 }),
    ).rejects.toThrow("owner credential is not current");
    expect(tunnelManager.start).not.toHaveBeenCalled();

    await workerService.startTunnel({
      environmentId: "worker-tunnel",
      ownerEpoch: 1,
    });
    expect(tunnelManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        bundleHash: support.BUNDLE_HASH,
        gateway: { host: "127.0.0.1", port: 18_789 },
        sharedHost: true,
      }),
    );
    expect(workerService.get("worker-tunnel")).toMatchObject({ tunnelStatus: "connected" });

    await workerService.destroy("worker-tunnel");
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
    expect(workerService.get("worker-tunnel")).toMatchObject({
      state: "destroyed",
      tunnelStatus: "stopped",
    });
  });

  it.each([
    ["stale receipt", { ...support.BOOTSTRAP_RECEIPT, bundleHash: "c".repeat(64) }, undefined],
    ["unavailable current bundle", support.BOOTSTRAP_RECEIPT, new Error("bundle unavailable")],
  ] as const)("rejects SSH tunnel startup with %s", async (_name, receipt, prepareError) => {
    const environmentId = "worker-tunnel-current-bundle";
    const bootstrapping = support.seedBootstrapping(environmentId, undefined, true);
    support.testState.store.transition({
      environmentId,
      from: bootstrapping.state,
      to: "ready",
      patch: support.readyPatch(environmentId, receipt),
    });
    if (prepareError) {
      support.testState.prepareInstallation = vi.fn(async () => {
        throw prepareError;
      });
    }
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    await expect(workerService.startTunnel({ environmentId, ownerEpoch: 1 })).rejects.toMatchObject(
      {
        code: "invalid_state",
        message: prepareError
          ? "Current worker build identity is unavailable"
          : STALE_WORKER_BUILD_REASON,
      } satisfies Partial<WorkerEnvironmentServiceError>,
    );
    expect(tunnelManager.start).not.toHaveBeenCalled();
  });

  it("selects a node tunnel from the persisted transport instead of provider id", async () => {
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    support.testState.config.cloudWorkers!.profiles!.development!.provider = "crabbox";
    const nodeHandle = {
      environmentId: "pending",
      ownerEpoch: 0,
      launchTurn: vi.fn(),
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: vi.fn(),
      syncWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const nodeTunnelManager = {
      bindWorkspaceBindingResolver: vi.fn(),
      status: () => "stopped" as const,
      start: vi.fn(async (request) => ({
        ...nodeHandle,
        environmentId: request.environmentId,
        ownerEpoch: request.ownerEpoch,
      })),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    };
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        id: "crabbox",
        provision: async () => ({
          leaseId: "cloud-lease",
          node: { deviceId: "device-1" },
        }),
      }),
      {
        tunnelManager,
        nodeTunnelManager,
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      },
    );
    const environment = await workerService.create("development", "cloud-node-tunnel-gate");
    const credential = await workerService.attachSession({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      sessionId: "session-device",
    });
    const prepareInstallation = vi.mocked(support.testState.prepareInstallation);
    const prepareCallsBeforeTunnel = prepareInstallation.mock.calls.length;

    await expect(
      workerService.startTunnel({
        environmentId: environment.environmentId,
        ownerEpoch: credential.ownerEpoch,
      }),
    ).resolves.toMatchObject({ environmentId: environment.environmentId });
    expect(tunnelManager.start).not.toHaveBeenCalled();
    expect(prepareInstallation).toHaveBeenCalledTimes(prepareCallsBeforeTunnel + 1);
    expect(nodeTunnelManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "device-1",
        sessionId: "session-device",
        expectedBuild: expect.objectContaining({ bundleHash: support.BUNDLE_HASH }),
      }),
    );
  });

  it("stops the node transport that owns a timed-out start", async () => {
    support.testState.config.cloudWorkers!.profiles!.development!.provider = "device";
    support.testState.config.cloudWorkers!.profiles!.development!.settings = {
      device: "device-1",
    };
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pendingStart = new Promise<never>(() => {});
    const sshStop = vi.fn(async () => {});
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: sshStop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const nodeTunnelManager = {
      bindWorkspaceBindingResolver: vi.fn(),
      status: () => "connecting" as const,
      start: vi.fn(() => {
        signalStarted();
        return pendingStart;
      }),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    };
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        id: "device",
        provision: async () => ({
          leaseId: "device-lease",
          node: { deviceId: "device-1" },
        }),
      }),
      {
        tunnelManager,
        nodeTunnelManager,
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      },
    );
    const environment = await workerService.create("development", "device-tunnel-timeout");
    const credential = await workerService.attachSession({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      sessionId: "session-device",
    });
    const sshStopCallsBeforeStart = sshStop.mock.calls.length;
    vi.useFakeTimers();

    const starting = workerService.startTunnel({
      environmentId: environment.environmentId,
      ownerEpoch: credential.ownerEpoch,
    });
    const rejected = expect(starting).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("did not connect within 3 minutes"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await started;
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await rejected;
    expect(nodeTunnelManager.stop).toHaveBeenCalledWith(
      environment.environmentId,
      credential.ownerEpoch,
    );
    expect(sshStop).toHaveBeenCalledTimes(sshStopCallsBeforeStart);
  });

  it("reconciles shared-host isolation for a persisted lease before tunnel startup", async () => {
    support.seedReady("worker-legacy-shared");
    support.testState.stateDb.db
      .prepare("UPDATE worker_environments SET shared_host = NULL WHERE environment_id = ?")
      .run("worker-legacy-shared");
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(async (request: Parameters<WorkerTunnelManager["start"]>[0]) => ({
        environmentId: request.environmentId,
        ownerEpoch: request.ownerEpoch,
        launchTurn: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        syncWorkspace: vi.fn(),
        stop: async () => {},
      })),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    let inspectionFails = true;
    const provider = support.createProvider({
      inspect: async () => {
        if (inspectionFails) {
          throw new Error("provider unavailable");
        }
        return { status: "active", sharedHost: true };
      },
    });
    const workerService = support.createService(provider, { tunnelManager });

    expect(support.testState.store.get("worker-legacy-shared")?.sharedHost).toBeNull();
    await workerService.reconcileOnce();
    await expect(
      workerService.startTunnel({ environmentId: "worker-legacy-shared", ownerEpoch: 1 }),
    ).rejects.toThrow("isolation is not reconciled");
    expect(tunnelManager.start).not.toHaveBeenCalled();
    inspectionFails = false;
    await workerService.reconcileOnce();
    expect(support.testState.store.get("worker-legacy-shared")?.sharedHost).toBe(true);
    await workerService.startTunnel({ environmentId: "worker-legacy-shared", ownerEpoch: 1 });
    expect(tunnelManager.start).toHaveBeenCalledWith(expect.objectContaining({ sharedHost: true }));
  });

  it("fences an existing tunnel before changing its shared-host isolation", async () => {
    support.seedReady("worker-isolation-change");
    const stop = vi.fn(async (_environmentId: string, _ownerEpoch?: number) => {
      expect(support.testState.store.get("worker-isolation-change")?.sharedHost).toBe(false);
    });
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      inspect: async () => ({ status: "active", sharedHost: true }),
    });

    await support.createService(provider, { tunnelManager }).reconcileOnce();

    expect(stop.mock.calls[0]?.[0]).toBe("worker-isolation-change");
    expect(support.testState.store.get("worker-isolation-change")?.sharedHost).toBe(true);
  });

  it("projects desktop availability only while a desktop lease is observable", () => {
    const ready = support.seedReadyDesktop("worker-desktop-projection");
    const workerService = support.createService(support.createProvider());
    expect(workerService.get(ready.environmentId)).toMatchObject({
      desktopAvailable: true,
      desktopApps: ["browser", "terminal"],
    });
    support.testState.store.transition({
      environmentId: ready.environmentId,
      from: ready.state,
      to: "draining",
    });
    expect(workerService.get(ready.environmentId)).toMatchObject({
      desktopAvailable: false,
      desktopApps: [],
    });
  });

  it("launches only an advertised desktop app through the pinned SSH runtime", async () => {
    const record = support.seedReadyDesktop("worker-desktop-launch");
    const launchApp = vi.fn(async () => {});
    const tunnelManager = {
      desktop: {
        acquire: vi.fn(),
        attachObserver: vi.fn(),
        launchApp,
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    await expect(
      workerService.launchDesktopApp({ environmentId: record.environmentId, app: "browser" }),
    ).resolves.toEqual({ app: "browser", status: "ready" });
    expect(launchApp).toHaveBeenCalledExactlyOnceWith({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      ssh: support.SSH_ENDPOINT,
      app: support.DESKTOP.apps?.[0],
      resolveIdentity: expect.any(Function),
    });
  });

  it("rejects missing desktop apps and maps launcher runtime failures to typed errors", async () => {
    const record = support.seedReadyDesktop("worker-desktop-launch-errors");
    const launchApp = vi.fn(async () => {
      throw new Error("private SSH launcher detail");
    });
    const tunnelManager = {
      desktop: {
        acquire: vi.fn(),
        attachObserver: vi.fn(),
        launchApp,
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    await expect(
      workerService.launchDesktopApp({ environmentId: record.environmentId, app: "browser" }),
    ).rejects.toMatchObject({
      code: "launcher_failure",
      message: "worker desktop browser launcher failed; verify the app is installed and retry",
    });
    support.testState.store.transition({
      environmentId: record.environmentId,
      from: record.state,
      to: "draining",
    });
    await expect(
      workerService.launchDesktopApp({ environmentId: record.environmentId, app: "terminal" }),
    ).rejects.toMatchObject({ code: "invalid_state" });

    const browserOnly = support.seedReadyDesktop("worker-desktop-browser-only", {
      ...support.DESKTOP,
      apps: [support.DESKTOP.apps![0]!],
    });
    await expect(
      workerService.launchDesktopApp({
        environmentId: browserOnly.environmentId,
        app: "terminal",
      }),
    ).rejects.toMatchObject({
      code: "desktop_app_not_found",
      message: "environment does not advertise desktop app: terminal",
    });
  });

  it("acquires a desktop tunnel and mints a one-shot websocket path", async () => {
    const record = support.seedReadyDesktop("worker-desktop-observe");
    const desktopPassword = ["desktop", String.fromCharCode(45), "secret"].join("");
    const acquire = vi.fn(async () => ({
      attachment: { kind: "unix-socket" as const, socketPath: "/tmp/worker-desktop.sock" },
      vncPassword: desktopPassword,
    }));
    const tunnelManager = {
      desktop: {
        acquire,
        attachObserver: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    await expect(
      workerService.observeDesktop({ environmentId: record.environmentId, control: true }),
    ).resolves.toMatchObject({
      transport: "rfb",
      wsPath: expect.stringMatching(/^\/desktop\/observe\?token=[a-f0-9]{48}$/u),
      expiresAtMs: support.testState.nowMs + 60_000,
      control: true,
      vncPassword: desktopPassword,
    });
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        desktop: support.DESKTOP,
        ssh: support.SSH_ENDPOINT,
        resolveIdentity: expect.any(Function),
      }),
    );
  });

  it("rejects desktop observe for invalid lifecycle gates and a stopped service", async () => {
    const tunnelManager = {
      desktop: {
        acquire: vi.fn(),
        attachObserver: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      },
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });
    const requested = support.testState.store.createIntent({
      environmentId: "worker-desktop-requested",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:worker-desktop-requested",
    });
    support.seedReady("worker-desktop-missing");
    const destroying = support.seedReadyDesktop("worker-desktop-destroy-requested");
    support.testState.store.requestDestroy({
      environmentId: destroying.environmentId,
      state: destroying.state,
    });

    support.testState.config.cloudWorkers!.desktop = false;
    await expect(
      workerService.observeDesktop({ environmentId: requested.environmentId, control: false }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message:
        "worker desktop observe is disabled; enable the Desktop lab in Control UI Settings -> Labs (config: cloudWorkers.desktop)",
    });
    support.testState.config.cloudWorkers!.desktop = true;

    for (const environmentId of [
      requested.environmentId,
      "worker-desktop-missing",
      destroying.environmentId,
    ]) {
      await expect(
        workerService.observeDesktop({ environmentId, control: false }),
      ).rejects.toMatchObject({
        code: "invalid_state",
        message: "environment has no desktop; desktop is a warm-time capability of the profile",
      });
    }
    await expect(
      workerService.observeDesktop({ environmentId: "worker-desktop-unknown", control: false }),
    ).rejects.toMatchObject({ code: "environment_not_found" });
    await workerService.stop();
    await expect(
      workerService.observeDesktop({ environmentId: destroying.environmentId, control: false }),
    ).rejects.toMatchObject({
      code: "invalid_state",
      message: "Worker environment service is stopping",
    });
    expect(tunnelManager.desktop.acquire).not.toHaveBeenCalled();
  });

  it("fences a draining tunnel before reporting an unavailable provider", async () => {
    support.seedReady("worker-provider-missing");
    const stop = vi.fn(async (_environmentId: string, _ownerEpoch?: number) => {});
    const tunnelManager = {
      status: () => "connected" as const,
      start: vi.fn(),
      stop,
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });
    support.testState.providersEnabled = false;

    await expect(workerService.destroy("worker-provider-missing")).rejects.toMatchObject({
      code: "provider_not_found",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(stop.mock.calls[0]?.[0]).toBe("worker-provider-missing");
    expect(support.testState.store.get("worker-provider-missing")).toMatchObject({
      state: "draining",
      destroyRequestedAtMs: expect.any(Number),
    });
  });

  it("does not hold the environment lock while a tunnel is connecting", async () => {
    support.seedReady("worker-tunnel-pending");
    let rejectStart: ((error: Error) => void) | undefined;
    const pendingStart = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const order: string[] = [];
    const tunnelManager = {
      status: () => "connecting" as const,
      start: vi.fn(() => pendingStart),
      stop: vi.fn(async () => {
        order.push("tunnel-stop");
        rejectStart?.(new Error("tunnel stopped"));
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const provider = support.createProvider({
      destroy: async () => {
        order.push("provider-destroy");
      },
    });
    const workerService = support.createService(provider, { tunnelManager });

    const starting = workerService.startTunnel({
      environmentId: "worker-tunnel-pending",
      ownerEpoch: 1,
    });
    const rejectedStart = expect(starting).rejects.toThrow("tunnel stopped");
    await support.waitForFast(() => expect(tunnelManager.start).toHaveBeenCalledOnce());

    await workerService.destroy("worker-tunnel-pending");

    await rejectedStart;
    expect(order).toEqual(["tunnel-stop", "provider-destroy"]);
  });

  it("stops a poisoned tunnel start and returns a typed deadline error", async () => {
    vi.useFakeTimers();
    support.seedReady("worker-tunnel-timeout");
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let rejectStart!: (error: Error) => void;
    const pendingStart = new Promise<never>((_resolve, reject) => {
      rejectStart = reject;
    });
    const tunnelManager = {
      status: () => "connecting" as const,
      start: vi.fn(() => {
        signalStarted();
        return pendingStart;
      }),
      stop: vi.fn(async () => {
        rejectStart(new Error("tunnel stopped"));
      }),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });

    const starting = workerService.startTunnel({
      environmentId: "worker-tunnel-timeout",
      ownerEpoch: 1,
    });
    const rejected = expect(starting).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining("did not connect within 3 minutes"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await started;
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    await rejected;
    expect(tunnelManager.stop).toHaveBeenCalledWith("worker-tunnel-timeout", 1);
  });
});
