import type { WorkerSshEndpoint } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DesktopSessionRegistry } from "../desktop/session-registry.js";
import { createWorkerDesktopTunnels } from "./desktop-tunnel.js";
import { prepareWorkerSsh, type PreparedWorkerSsh, type WorkerSshIdentityResolver } from "./ssh.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelHandle,
  type WorkerTunnelRequest,
  type WorkerWorkspaceTunnelHandle,
  type WorkerTunnelStatus,
} from "./tunnel-contract.js";
import { createWorkerSshRunner, type WorkerSshRunner } from "./tunnel-ssh-runner.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

export type { WorkerTunnelHandle } from "./tunnel-contract.js";

type WorkerTunnelStartRequest = WorkerTunnelRequest & {
  bundleHash: string;
  ssh: WorkerSshEndpoint;
  sharedHost?: boolean;
  resolveIdentity: WorkerSshIdentityResolver;
};

type TunnelEntry = {
  bundleHash: string;
  environmentId: string;
  ownerEpoch: number;
  sharedHost: boolean;
  abortController: AbortController;
  status: Exclude<WorkerTunnelStatus, "stopped">;
  prepared?: PreparedWorkerSsh;
  initialization: Promise<WorkerTunnelHandle>;
  stopPromise?: Promise<void>;
  workspaceTasks: Set<Promise<unknown>>;
};

type WorkerTunnelManagerOptions = {
  runner?: WorkerSshRunner;
  desktopSessionRegistry?: DesktopSessionRegistry;
};

function validateStartRequest(request: WorkerTunnelStartRequest): void {
  if (!request.environmentId.trim()) {
    throw new Error("Worker tunnel environment id must be non-empty");
  }
  if (!Number.isSafeInteger(request.ownerEpoch) || request.ownerEpoch < 0) {
    throw new Error("Worker tunnel owner epoch must be a non-negative safe integer");
  }
}

/** Owns SSH workspace state for remote-exec environments and fences replacement epochs. */
export function createWorkerTunnelManager(options: WorkerTunnelManagerOptions = {}) {
  const runner = options.runner ?? createWorkerSshRunner();
  const desktop = createWorkerDesktopTunnels({
    runner,
    ...(options.desktopSessionRegistry ? { registry: options.desktopSessionRegistry } : {}),
  });
  const entries = new Map<string, TunnelEntry>();
  const owners = new Set<TunnelEntry>();
  const claimedOwnerEpochs = new Map<string, number>();

  const isCurrent = (entry: TunnelEntry) =>
    entries.get(entry.environmentId) === entry && !entry.abortController.signal.aborted;

  const createHandle = (entry: TunnelEntry): WorkerWorkspaceTunnelHandle => {
    const waitForPrepared = async (): Promise<PreparedWorkerSsh> => {
      if (isCurrent(entry) && entry.status === "connected" && entry.prepared) {
        return entry.prepared;
      }
      throw new WorkerTunnelOwnerDisconnectedError();
    };
    const workspace = createWorkerWorkspaceActions({
      environmentId: entry.environmentId,
      sharedHost: entry.sharedHost,
      ownerSignal: entry.abortController.signal,
      waitForPrepared,
      runner,
      tasks: entry.workspaceTasks,
      bundleHash: entry.bundleHash,
    });
    return {
      environmentId: entry.environmentId,
      ownerEpoch: entry.ownerEpoch,
      ...workspace,
      stop: () => stop(entry.environmentId, entry.ownerEpoch),
    };
  };

  const stopEntry = (entry: TunnelEntry): Promise<void> => {
    if (entry.stopPromise) {
      return entry.stopPromise;
    }
    // Abort callbacks can reenter Stop. Publish the shared close before fencing
    // input, and retain cleanup custody after this owner leaves the live index.
    const stopped = createDeferredCore();
    entry.stopPromise = stopped.promise;
    if (entries.get(entry.environmentId) === entry) {
      entries.delete(entry.environmentId);
    }
    entry.abortController.abort(new Error("Worker tunnel owner stopped"));
    void (async () => {
      await entry.initialization.catch(() => undefined);
      await Promise.allSettled(entry.workspaceTasks);
      await entry.prepared?.dispose().catch(() => undefined);
    })()
      .finally(() => owners.delete(entry))
      .then(stopped.resolve, stopped.reject);
    return entry.stopPromise;
  };

  async function start(request: WorkerTunnelStartRequest): Promise<WorkerTunnelHandle> {
    validateStartRequest(request);
    const claimedEpoch = claimedOwnerEpochs.get(request.environmentId);
    if (claimedEpoch !== undefined && request.ownerEpoch < claimedEpoch) {
      throw new Error("Worker tunnel owner epoch is stale");
    }
    claimedOwnerEpochs.set(request.environmentId, request.ownerEpoch);
    const current = entries.get(request.environmentId);
    if (current?.ownerEpoch === request.ownerEpoch) {
      return await current.initialization;
    }

    const previous = [...owners].filter((owner) => owner.environmentId === request.environmentId);
    const initializing = createDeferredCore<WorkerTunnelHandle>();
    const entry: TunnelEntry = {
      environmentId: request.environmentId,
      bundleHash: request.bundleHash,
      ownerEpoch: request.ownerEpoch,
      sharedHost: request.sharedHost === true,
      abortController: new AbortController(),
      status: "connecting",
      workspaceTasks: new Set(),
      initialization: initializing.promise,
    };
    // Publish initialization before retiring prior owners: their abort callbacks
    // may stop this replacement, which must still join the entire cleanup chain.
    owners.add(entry);
    entries.set(request.environmentId, entry);
    void (async () => {
      await Promise.all(previous.map(stopEntry));
      if (!isCurrent(entry)) {
        throw new WorkerTunnelOwnerDisconnectedError();
      }
      const prepared = await prepareWorkerSsh({
        ssh: request.ssh,
        pinnedHostKey: request.ssh.hostKey,
        resolveIdentity: request.resolveIdentity,
        temporaryDirectoryPrefix: "openclaw-worker-workspace-",
      });
      if (!isCurrent(entry)) {
        await prepared.dispose();
        throw new WorkerTunnelOwnerDisconnectedError();
      }
      entry.prepared = prepared;
      entry.status = "connected";
      return createHandle(entry);
    })().then(initializing.resolve, initializing.reject);
    try {
      return await entry.initialization;
    } catch (error) {
      await stopEntry(entry);
      throw error;
    }
  }

  async function stop(environmentId: string, ownerEpoch?: number): Promise<void> {
    await Promise.all(
      [...owners]
        .filter(
          (entry) =>
            entry.environmentId === environmentId &&
            (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch),
        )
        .map(stopEntry),
    );
    await desktop.stop(environmentId, ownerEpoch);
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...[...owners].map(stopEntry), desktop.stopAll()]);
  }

  return {
    desktop,
    start,
    stop,
    stopAll,
    status(environmentId: string): WorkerTunnelStatus {
      return entries.get(environmentId)?.status ?? "stopped";
    },
  };
}

export type WorkerTunnelManager = ReturnType<typeof createWorkerTunnelManager>;
