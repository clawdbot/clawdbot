import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.js";
import { withTimeout } from "../../infra/fs-safe.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { verifyWorkerAdmissionHandshake, type ExpectedWorkerBuild } from "./admission.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider.js";
import type { NodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { WorkerDesktopLaunchResult, WorkerDesktopObserveResult } from "./service-contract.js";
import type { WorkerEnvironmentState } from "./state.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import type {
  WorkerRecoveryTunnelRequest,
  WorkerTunnelRequest,
  WorkerWorkspaceRecoveryTunnelHandle,
} from "./tunnel-contract.js";
import type { WorkerTunnelHandle, WorkerTunnelManager } from "./tunnel.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const TUNNEL_START_TIMEOUT_MS = 3 * 60_000;

type WorkerTunnelAccess =
  | { kind: "current-worker" }
  | { kind: "workspace-recovery"; authorizePendingResult: () => boolean };

type WorkerEnvironmentAccessOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  prepareCurrentBundle: () => Promise<ExpectedWorkerBuild>;
  tunnelManager?: WorkerTunnelManager;
  nodeTunnelManager?: NodeWorkerTunnelManager;
  resolveWorkerGateway?: () => { host: "127.0.0.1" | "::1"; port: number } | undefined;
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
      | "worker_build_mismatch"
      | "unsupported_platform",
    message: string,
  ) => Error;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerEnvironmentAccess(options: WorkerEnvironmentAccessOptions) {
  const { store } = options;
  const tunnels = options.tunnelManager;
  const nodeTunnels = options.nodeTunnelManager;
  const now = options.now;
  const inState = options.inState;
  const providerFor = options.providerFor;
  const identityResolverFor = options.identityResolverFor;
  const serviceError = options.serviceError;
  const withLock = options.withLock;

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

  const startTunnelAccess = async (
    request: WorkerTunnelRequest,
    access: WorkerTunnelAccess,
  ): Promise<WorkerTunnelHandle> => {
    let stopping = options.isStopping();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    if (!tunnels && !nodeTunnels) {
      throw serviceError("invalid_state", "Worker tunnel runtime is unavailable");
    }
    let startup: Promise<WorkerTunnelHandle> | undefined;
    let stopStartup: (() => Promise<void>) | undefined;
    const hasWorkspaceRecoveryAuthority = (record: WorkerEnvironmentRecord | undefined): boolean =>
      access.kind === "workspace-recovery" &&
      Boolean(
        record &&
        inState(record, "ready", "idle", "attached") &&
        record.leaseId &&
        record.ownerEpoch === request.ownerEpoch &&
        access.authorizePendingResult(),
      );
    await withLock(request.environmentId, async () => {
      stopping = options.isStopping();
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const record = store.get(request.environmentId);
      if (!record) {
        throw serviceError(
          "environment_not_found",
          `Unknown worker environment: ${request.environmentId}`,
        );
      }
      const workspaceRecoveryAuthorized = hasWorkspaceRecoveryAuthority(record);
      if (
        !inState(record, "ready", "idle", "attached") ||
        (record.destroyRequestedAtMs !== null && !workspaceRecoveryAuthorized) ||
        !record.leaseId
      ) {
        throw serviceError("invalid_state", `Cannot start tunnel in state: ${record.state}`);
      }
      if (!record.bootstrapReceipt) {
        throw serviceError("invalid_state", `Cannot start tunnel in state: ${record.state}`);
      }
      if (record.ownerEpoch !== request.ownerEpoch) {
        throw serviceError("invalid_state", "Worker tunnel environment owner is not current");
      }
      if (record.sharedHost === null) {
        throw serviceError(
          "provider_failure",
          "Worker lease isolation is not reconciled; retry after provider inspection",
        );
      }
      if (access.kind === "current-worker") {
        const credential = store.getCredential(request.environmentId);
        if (
          !credential ||
          credential.ownerEpoch !== request.ownerEpoch ||
          credential.expiresAtMs <= now()
        ) {
          throw serviceError("invalid_state", "Worker tunnel owner credential is not current");
        }
      } else if (!workspaceRecoveryAuthorized) {
        throw serviceError("invalid_state", "Worker workspace recovery authority is not current");
      }
      let tunnelBundleHash = record.bootstrapReceipt.bundleHash;
      let currentBundle: ExpectedWorkerBuild | undefined;
      const usesInstalledSshBundle =
        access.kind === "workspace-recovery" && record.sshEndpoint !== null;
      if (!usesInstalledSshBundle) {
        try {
          currentBundle = await options.prepareCurrentBundle();
        } catch {
          throw serviceError("invalid_state", "Current worker build identity is unavailable");
        }
        if (!verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle)) {
          throw serviceError(
            "worker_build_mismatch",
            "Worker must bootstrap the current build before continuing",
          );
        }
        tunnelBundleHash = currentBundle.bundleHash;
      }
      const nodeBundle =
        record.providerId === DEVICE_WORKER_PROVIDER_ID &&
        !record.sshEndpoint &&
        record.bootstrapReceipt.installKind === "bundle";
      if (nodeBundle) {
        if (!currentBundle) {
          throw serviceError("invalid_state", "Current worker build identity is unavailable");
        }
        const profileSettings = record.profileSnapshot.settings;
        const deviceId = isRecord(profileSettings) ? profileSettings.device : undefined;
        const sessionId = record.attachedSessionIds[0];
        if (!nodeTunnels || typeof deviceId !== "string" || !deviceId.trim() || !sessionId) {
          throw serviceError("invalid_state", "Device worker tunnel runtime is unavailable");
        }
        startup = nodeTunnels.start({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          deviceId: deviceId.trim(),
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
      const gateway = options.resolveWorkerGateway?.();
      if (!gateway) {
        throw serviceError("invalid_state", "Worker gateway ingress is unavailable");
      }
      const provider = providerFor(record.providerId);
      // Tunnel ownership is registered synchronously by the manager. Release the durable-state
      // lock while SSH connects so drain/destroy can fence an indefinitely reconnecting start.
      startup = tunnels.start({
        ...request,
        bundleHash: tunnelBundleHash,
        gateway,
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
      "Worker tunnel did not connect within 3 minutes; check worker SSH reachability and retry",
    );
    try {
      const tunnel = await withTimeout(startup, TUNNEL_START_TIMEOUT_MS, {
        createError: () => timeoutError,
      });
      if (access.kind === "workspace-recovery") {
        const recoveryAuthorized = await withLock(request.environmentId, async () =>
          hasWorkspaceRecoveryAuthority(store.get(request.environmentId)),
        );
        if (!recoveryAuthorized) {
          await stopStartup?.().catch(() => undefined);
          throw serviceError("invalid_state", "Worker workspace recovery authority is not current");
        }
      }
      return tunnel;
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

  const startTunnel = async (request: WorkerTunnelRequest): Promise<WorkerTunnelHandle> =>
    await startTunnelAccess(request, { kind: "current-worker" });

  const startRecoveryTunnel = async (
    request: WorkerRecoveryTunnelRequest,
  ): Promise<WorkerWorkspaceRecoveryTunnelHandle> => {
    const tunnelRequest = {
      environmentId: request.environmentId,
      ownerEpoch: request.ownerEpoch,
    };
    const access: WorkerTunnelAccess =
      request.workerBuild === "current"
        ? { kind: "current-worker" }
        : {
            kind: "workspace-recovery",
            authorizePendingResult: request.authorizePendingResult,
          };
    const tunnel = await startTunnelAccess(tunnelRequest, access);
    return {
      environmentId: tunnel.environmentId,
      ownerEpoch: tunnel.ownerEpoch,
      quiesceWorkspace: tunnel.quiesceWorkspace,
      reconcileWorkspace: tunnel.reconcileWorkspace,
      runWorkspaceCommand: tunnel.runWorkspaceCommand,
      stop: tunnel.stop,
      syncWorkspace: tunnel.syncWorkspace,
    };
  };

  const observeDesktop = async (request: {
    environmentId: string;
    control: boolean;
  }): Promise<WorkerDesktopObserveResult> => {
    let stopping = options.isStopping();
    if (options.getConfig().cloudWorkers?.desktop !== true) {
      throw serviceError(
        "invalid_state",
        "worker desktop observe is disabled; enable the Desktop lab in Control UI Settings -> Labs (config: cloudWorkers.desktop)",
      );
    }
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    if (!tunnels) {
      throw serviceError("invalid_state", "Worker tunnel runtime is unavailable");
    }
    let startup: ReturnType<WorkerTunnelManager["desktop"]["acquire"]> | undefined;
    let ownerEpoch: number | undefined;
    await withLock(request.environmentId, async () => {
      stopping = options.isStopping();
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const record = store.get(request.environmentId);
      if (!record) {
        throw serviceError(
          "environment_not_found",
          `Unknown worker environment: ${request.environmentId}`,
        );
      }
      if (
        !inState(record, "ready", "idle", "attached") ||
        record.destroyRequestedAtMs !== null ||
        !record.leaseId ||
        !record.sshEndpoint ||
        !record.desktop
      ) {
        throw serviceError(
          "invalid_state",
          "environment has no desktop; desktop is a warm-time capability of the profile",
        );
      }
      const provider = providerFor(record.providerId);
      ownerEpoch = record.ownerEpoch;
      startup = tunnels.desktop.acquire({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        ssh: record.sshEndpoint,
        desktop: record.desktop,
        resolveIdentity: identityResolverFor(record, provider, record.leaseId),
      });
    });
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
    let stopping = options.isStopping();
    if (options.getConfig().cloudWorkers?.desktop !== true) {
      throw serviceError(
        "invalid_state",
        "worker desktop launch is disabled; enable the Desktop lab in Control UI Settings -> Labs (config: cloudWorkers.desktop)",
      );
    }
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    if (!tunnels) {
      throw serviceError("invalid_state", "Worker tunnel runtime is unavailable");
    }
    const requireLaunchable = () => {
      stopping = options.isStopping();
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const record = store.get(request.environmentId);
      if (!record) {
        throw serviceError(
          "environment_not_found",
          `Unknown worker environment: ${request.environmentId}`,
        );
      }
      if (
        !inState(record, "ready", "idle", "attached") ||
        record.destroyRequestedAtMs !== null ||
        !record.leaseId ||
        !record.sshEndpoint ||
        !record.desktop
      ) {
        throw serviceError(
          "invalid_state",
          "environment has no desktop; desktop is a warm-time capability of the profile",
        );
      }
      const app = record.desktop.apps?.find((candidate) => candidate.id === request.app);
      if (!app) {
        throw serviceError(
          "desktop_app_not_found",
          `environment does not advertise desktop app: ${request.app}`,
        );
      }
      return { app, record, sshEndpoint: record.sshEndpoint };
    };

    let startup: Promise<void> | undefined;
    let launchEpoch: number | undefined;
    await withLock(request.environmentId, async () => {
      const { app, record, sshEndpoint } = requireLaunchable();
      const provider = providerFor(record.providerId);
      launchEpoch = record.ownerEpoch;
      startup = tunnels.desktop.launchApp({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        ssh: sshEndpoint,
        app,
        resolveIdentity: identityResolverFor(record, provider, record.leaseId),
      });
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

  const stopTunnel = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    await withLock(environmentId, async () => {
      await Promise.all([
        tunnels?.stop(environmentId, ownerEpoch),
        nodeTunnels?.stop(environmentId, ownerEpoch),
      ]);
    });
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
    startRecoveryTunnel,
    startTunnel,
    stopAllTunnels: async () => {
      await Promise.all([tunnels?.stopAll(), nodeTunnels?.stopAll()]);
    },
    stopTunnel,
  };
}
