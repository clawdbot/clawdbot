import type { OpenClawConfig } from "../../config/types.js";
import { withTimeout } from "../../infra/fs-safe.js";
import type { WorkerProvider } from "../../plugins/types.js";
import {
  StaleWorkerBuildError,
  verifyWorkerAdmissionHandshake,
  type ExpectedWorkerBuild,
} from "./admission.js";
import type { WorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import type { NodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { WorkerDesktopLaunchResult, WorkerDesktopObserveResult } from "./service-contract.js";
import type { WorkerEnvironmentState } from "./state.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelRequest } from "./tunnel-contract.js";
import type { WorkerTunnelHandle, WorkerTunnelManager } from "./tunnel.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const TUNNEL_START_TIMEOUT_MS = 3 * 60_000;

type WorkerEnvironmentAccessOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  prepareCurrentBundle: () => Promise<ExpectedWorkerBuild>;
  tunnelManager?: WorkerTunnelManager;
  nodeTunnelManager?: NodeWorkerTunnelManager;
  nodeDesktopCarrier?: WorkerNodeDesktopCarrier;
  now: () => number;
  identityResolverFor: (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    leaseId: string,
  ) => Parameters<WorkerTunnelManager["start"]>[0]["resolveIdentity"];
  inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) => boolean;
  isStopping: () => boolean;
  providerFor: (providerId: string) => WorkerProvider;
  serviceError: (
    code:
      | "desktop_app_not_found"
      | "environment_not_found"
      | "invalid_state"
      | "launcher_failure"
      | "provider_failure"
      | "unsupported_platform",
    message: string,
  ) => Error;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerEnvironmentAccess(options: WorkerEnvironmentAccessOptions) {
  const { store } = options;
  const tunnels = options.tunnelManager;
  const nodeTunnels = options.nodeTunnelManager;
  const nodeDesktop = options.nodeDesktopCarrier;
  const now = options.now;
  const inState = options.inState;
  const providerFor = options.providerFor;
  const identityResolverFor = options.identityResolverFor;
  const serviceError = options.serviceError;
  const withLock = options.withLock;

  const requireCurrentRecord = (environmentId: string) => {
    if (options.isStopping()) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const record = store.get(environmentId);
    if (!record) {
      throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
    }
    return record;
  };

  const requireDesktopRecord = (environmentId: string) => {
    const record = requireCurrentRecord(environmentId);
    if (
      !inState(record, "ready", "idle", "attached") ||
      record.destroyRequestedAtMs !== null ||
      !record.leaseId ||
      !record.desktop
    ) {
      throw serviceError(
        "invalid_state",
        "environment has no desktop; desktop is a warm-time capability of the profile",
      );
    }
    return { record, desktop: record.desktop, leaseId: record.leaseId };
  };

  const project = (record: WorkerEnvironmentRecord) => {
    const desktopAvailable =
      inState(record, "ready", "idle", "attached") && record.desktop !== null;
    const nodeTunnelStatus = nodeTunnels?.status(record.environmentId);
    return {
      ...record,
      ...((record.state === "failed" || record.state === "orphaned") && record.lastError
        ? { error: boundedError(record.lastError) }
        : {}),
      desktopAvailable,
      desktopApps: desktopAvailable
        ? (record.desktop?.apps?.map((app) => app.id).toSorted() ?? [])
        : [],
      tunnelStatus:
        nodeTunnelStatus && nodeTunnelStatus !== "stopped"
          ? nodeTunnelStatus
          : (tunnels?.status(record.environmentId) ?? nodeTunnelStatus ?? ("stopped" as const)),
    };
  };

  const startTunnel = async (request: WorkerTunnelRequest): Promise<WorkerTunnelHandle> => {
    const stopping = options.isStopping();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    if (!tunnels && !nodeTunnels) {
      throw serviceError("invalid_state", "Worker tunnel runtime is unavailable");
    }
    // Prepare process-stable metadata outside the lock, then validate the durable
    // owner once. Credential revocation may happen while this await is pending.
    let currentBundle: ExpectedWorkerBuild;
    try {
      currentBundle = await options.prepareCurrentBundle();
    } catch {
      throw serviceError("invalid_state", "Current worker build identity is unavailable");
    }
    let startup: Promise<WorkerTunnelHandle> | undefined;
    let stopStartup: (() => Promise<void>) | undefined;
    await withLock(request.environmentId, async () => {
      const record = requireCurrentRecord(request.environmentId);
      if (
        !inState(record, "ready", "idle", "attached") ||
        record.destroyRequestedAtMs !== null ||
        !record.leaseId
      ) {
        throw serviceError("invalid_state", `Cannot start tunnel in state: ${record.state}`);
      }
      if (!record.bootstrapReceipt) {
        throw serviceError("invalid_state", `Cannot start tunnel in state: ${record.state}`);
      }
      if (record.sharedHost === null) {
        throw serviceError(
          "provider_failure",
          "Worker lease isolation is not reconciled; retry after provider inspection",
        );
      }
      const credential = store.getCredential(request.environmentId);
      if (
        record.ownerEpoch !== request.ownerEpoch ||
        !credential ||
        credential.ownerEpoch !== request.ownerEpoch
      ) {
        throw serviceError("invalid_state", "Worker tunnel owner credential is not current");
      }
      if (!verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle)) {
        throw new StaleWorkerBuildError();
      }
      const nodeDeviceId = record.nodeDeviceId;
      const nodeBundle =
        typeof nodeDeviceId === "string" &&
        !record.sshEndpoint &&
        record.bootstrapReceipt.installKind === "bundle";
      if (nodeBundle) {
        const sessionId = record.attachedSessionIds[0];
        if (
          !nodeTunnels ||
          !sessionId ||
          record.attachedSessionIds.length !== 1 ||
          credential.sessionId !== sessionId
        ) {
          throw serviceError("invalid_state", "Node worker tunnel runtime is unavailable");
        }
        startup = nodeTunnels.start({
          executionMode:
            record.profileSnapshot.executionMode === "remote-exec" ? "remote-exec" : "worker-turn",
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          deviceId: nodeDeviceId,
          sessionId,
          expectedBuild: {
            bundleHash: currentBundle.bundleHash,
            openclawVersion: currentBundle.openclawVersion,
            protocolFeatures: [...currentBundle.protocolFeatures],
          },
        });
        stopStartup = async () => await nodeTunnels.stop(record.environmentId, record.ownerEpoch);
        return;
      }
      if (!record.sshEndpoint) {
        throw serviceError("invalid_state", "Worker environment has no supported tunnel transport");
      }
      if (!tunnels) {
        throw serviceError("invalid_state", "Worker SSH tunnel runtime is unavailable");
      }
      const provider = providerFor(record.providerId);
      // Workspace ownership is registered synchronously by the manager. Release the durable-state
      // lock while SSH identity material is prepared so drain/destroy can fence initialization.
      startup = tunnels.start({
        ...request,
        bundleHash: currentBundle.bundleHash,
        ssh: record.sshEndpoint,
        sharedHost: record.sharedHost,
        resolveIdentity: identityResolverFor(record, provider, record.leaseId),
      });
      stopStartup = async () => await tunnels.stop(record.environmentId, record.ownerEpoch);
    });
    if (!startup) {
      throw serviceError("invalid_state", "Worker tunnel failed to start");
    }
    const timeoutError = serviceError(
      "provider_failure",
      "Worker tunnel did not connect within 3 minutes; check that the worker is online and reachable, then retry",
    );
    try {
      return await withTimeout(startup, TUNNEL_START_TIMEOUT_MS, {
        createError: () => timeoutError,
      });
    } catch (error) {
      if (error !== timeoutError) {
        throw error;
      }
      // Stop can itself block on an unkillable transport child; detach it (rejection observed,
      // entry stays manager-tracked) so the deadline error is returned on time. Epoch-fenced
      // so a stale timed-out attempt can never tear down a newer owner's tunnel.
      void stopStartup?.().catch(() => undefined);
      throw timeoutError;
    }
  };

  const observeDesktop = async (request: {
    environmentId: string;
    control: boolean;
  }): Promise<WorkerDesktopObserveResult> => {
    const stopping = options.isStopping();
    if (options.getConfig().cloudWorkers?.desktop !== true) {
      throw serviceError(
        "invalid_state",
        "worker desktop observe is disabled; enable the Desktop lab in Control UI Settings -> Labs (config: cloudWorkers.desktop)",
      );
    }
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    let startup: ReturnType<WorkerTunnelManager["desktop"]["acquire"]> | undefined;
    let nodeStartup: ReturnType<WorkerNodeDesktopCarrier["observe"]> | undefined;
    let ownerEpoch: number | undefined;
    await withLock(request.environmentId, async () => {
      const { record, desktop, leaseId } = requireDesktopRecord(request.environmentId);
      ownerEpoch = record.ownerEpoch;
      if (record.sshEndpoint) {
        if (!tunnels) {
          throw serviceError("invalid_state", "Worker SSH desktop runtime is unavailable");
        }
        const provider = providerFor(record.providerId);
        startup = tunnels.desktop.acquire({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          ssh: record.sshEndpoint,
          desktop,
          resolveIdentity: identityResolverFor(record, provider, leaseId),
        });
        return;
      }
      if (record.nodeDeviceId) {
        if (!nodeDesktop) {
          throw serviceError("invalid_state", "Worker node desktop runtime is unavailable");
        }
        nodeStartup = nodeDesktop.observe({
          record,
          control: request.control,
        });
        return;
      }
      throw serviceError("invalid_state", "Worker environment has no desktop transport");
    });
    if (nodeStartup) {
      return await nodeStartup;
    }
    if (!startup || ownerEpoch === undefined) {
      throw serviceError("invalid_state", "Worker desktop tunnel failed to start");
    }
    const acquired = await startup;
    const { DESKTOP_OBSERVE_PATH, mintDesktopObserverToken } =
      await import("../desktop/observe-bridge.js");
    const minted = mintDesktopObserverToken({
      sourceKey: request.environmentId,
      ownerEpoch,
      control: request.control,
      attachment: acquired.attachment,
      nowMs: now(),
    });
    return {
      transport: "rfb",
      wsPath: `${DESKTOP_OBSERVE_PATH}?token=${minted.token}`,
      expiresAtMs: minted.expiresAtMs,
      control: request.control,
      ...(acquired.vncPassword ? { vncPassword: acquired.vncPassword } : {}),
    };
  };

  const launchDesktopApp = async (request: {
    environmentId: string;
    app: "browser" | "terminal";
  }): Promise<WorkerDesktopLaunchResult> => {
    const stopping = options.isStopping();
    if (options.getConfig().cloudWorkers?.desktop !== true) {
      throw serviceError(
        "invalid_state",
        "worker desktop launch is disabled; enable the Desktop lab in Control UI Settings -> Labs (config: cloudWorkers.desktop)",
      );
    }
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const requireLaunchable = () => {
      const { record, desktop, leaseId } = requireDesktopRecord(request.environmentId);
      const app = desktop.apps?.find((candidate) => candidate.id === request.app);
      if (!app) {
        throw serviceError(
          "desktop_app_not_found",
          `environment does not advertise desktop app: ${request.app}`,
        );
      }
      return { app, record, leaseId };
    };

    let startup: Promise<void> | undefined;
    let launchEpoch: number | undefined;
    await withLock(request.environmentId, async () => {
      const { app, record, leaseId } = requireLaunchable();
      launchEpoch = record.ownerEpoch;
      if (record.sshEndpoint) {
        if (!tunnels) {
          throw serviceError("invalid_state", "Worker SSH desktop runtime is unavailable");
        }
        const provider = providerFor(record.providerId);
        startup = tunnels.desktop.launchApp({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          ssh: record.sshEndpoint,
          app,
          resolveIdentity: identityResolverFor(record, provider, leaseId),
        });
        return;
      }
      if (record.nodeDeviceId) {
        if (!nodeDesktop) {
          throw serviceError("invalid_state", "Worker node desktop runtime is unavailable");
        }
        startup = nodeDesktop.launchApp({ record, app });
        return;
      }
      throw serviceError("invalid_state", "Worker environment has no desktop transport");
    });
    if (!startup || launchEpoch === undefined) {
      throw serviceError("launcher_failure", "Worker desktop app launcher failed to start");
    }
    try {
      await startup;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "unsupported_platform"
      ) {
        throw serviceError(
          "unsupported_platform",
          "desktop app launch is not supported on Windows gateway hosts",
        );
      }
      // A teardown aborts the SSH child before mutating the durable row. Wait for the
      // environment lock, then report the authoritative lifecycle state instead of a launch error.
      await withLock(request.environmentId, async () => {
        const { record } = requireLaunchable();
        if (record.ownerEpoch !== launchEpoch) {
          throw serviceError("invalid_state", "Worker desktop app launch owner changed");
        }
      });
      throw serviceError(
        "launcher_failure",
        `worker desktop ${request.app} launcher failed; verify the app is installed and retry`,
      );
    }
    await withLock(request.environmentId, async () => {
      const { record } = requireLaunchable();
      if (record.ownerEpoch !== launchEpoch) {
        throw serviceError("invalid_state", "Worker desktop app launch owner changed");
      }
    });
    return { app: request.app, status: "ready" };
  };

  const stopTunnelOwners = async (stops: Array<Promise<void> | undefined>): Promise<void> => {
    const results = await Promise.allSettled(stops.filter((stop) => stop !== undefined));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  };

  const stopTunnel = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    await withLock(environmentId, async () =>
      stopTunnelOwners([
        tunnels?.stop(environmentId, ownerEpoch),
        nodeTunnels?.stop(environmentId, ownerEpoch),
        nodeDesktop?.stop(environmentId, ownerEpoch),
      ]),
    );
  };

  return {
    get: (environmentId: string) => {
      const record = store.get(environmentId);
      return record ? project(record) : undefined;
    },
    launchDesktopApp,
    list: () => store.list().map(project),
    observeDesktop,
    project,
    startTunnel,
    stopAllTunnels: () =>
      stopTunnelOwners([tunnels?.stopAll(), nodeTunnels?.stopAll(), nodeDesktop?.stopAll()]),
    stopTunnel,
  };
}
