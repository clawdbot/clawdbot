import type { WorkerSshEndpoint } from "../../plugins/types.js";
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
  initialization?: Promise<WorkerTunnelHandle>;
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
    entry.stopPromise = (async () => {
      if (entries.get(entry.environmentId) === entry) {
        entries.delete(entry.environmentId);
      }
      entry.abortController.abort(new Error("Worker tunnel owner stopped"));
      await entry.initialization?.catch(() => undefined);
      await Promise.allSettled(entry.workspaceTasks);
      await entry.prepared?.dispose().catch(() => undefined);
    })();
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
    if (current) {
      if (request.ownerEpoch < current.ownerEpoch) {
        throw new Error("Worker tunnel owner epoch is stale");
      }
      if (request.ownerEpoch === current.ownerEpoch) {
        return await current.initialization!;
      }
    }

    const entry: TunnelEntry = {
      environmentId: request.environmentId,
      bundleHash: request.bundleHash,
      ownerEpoch: request.ownerEpoch,
      sharedHost: request.sharedHost === true,
      abortController: new AbortController(),
      status: "connecting",
      workspaceTasks: new Set(),
    };
    // Publish the new owner before waiting for prior teardown so stop/drain can fence initialization.
    entries.set(request.environmentId, entry);
    entry.initialization = (async () => {
      if (current) {
        await stopEntry(current);
      }
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
    })();
    try {
      return await entry.initialization;
    } catch (error) {
      await stopEntry(entry);
      throw error;
    }
  }

  async function stop(environmentId: string, ownerEpoch?: number): Promise<void> {
    const entry = entries.get(environmentId);
    if (entry && (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch)) {
      await stopEntry(entry);
    }
    await desktop.stop(environmentId, ownerEpoch);
  }

  async function stopAll(): Promise<void> {
    const current = [...entries.values()];
    entries.clear();
    for (const entry of current) {
      entry.abortController.abort(new Error("Worker tunnel manager stopped"));
    }
    await Promise.all([...current.map(stopEntry), desktop.stopAll()]);
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
