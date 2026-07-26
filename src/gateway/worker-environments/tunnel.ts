import { RetrySupervisor } from "../../../packages/retry/src/index.js";
import { sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import type { SpawnResult } from "../../process/exec.js";
import {
  prepareWorkerSsh,
  type PreparedWorkerSsh,
  type WorkerSshIdentityResolver,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "./ssh.js";
import type {
  WorkerTunnelHandle,
  WorkerTunnelRequest,
  WorkerTunnelStatus,
} from "./tunnel-contract.js";
import {
  createWorkerSshRunner,
  type WorkerSshProcess,
  type WorkerSshRunner,
  workerSshProcessError,
  WORKER_TUNNEL_READY_MARKER,
} from "./tunnel-ssh-runner.js";
import { createWorkerWorkspaceActions, stableWorkerPathComponent } from "./workspace-sync.js";

export type { WorkerTunnelHandle } from "./tunnel-contract.js";
const REMOTE_SOCKET_NAME = "gateway.sock";
const REMOTE_SETUP_TIMEOUT_MS = 20_000;
const DEFAULT_STABLE_CONNECTION_MS = 30_000;
const DEFAULT_BACKOFF: BackoffPolicy = {
  initialMs: 250,
  maxMs: 30_000,
  factor: 2,
  jitter: 0,
};

const REMOTE_SOCKET_SETUP_SCRIPT = String.raw`set -eu
directory=$1
socket=$2
umask 077
if [ -e "$directory" ] || [ -L "$directory" ]; then
  if [ ! -d "$directory" ] || [ -L "$directory" ]; then
    printf '%s\n' 'unsafe worker tunnel directory' >&2
    exit 2
  fi
else
  mkdir -- "$directory"
fi
chmod 700 -- "$directory"
rm -f -- "$socket"
`;

const REMOTE_TUNNEL_READY_SCRIPT = String.raw`set -eu
socket=$1
test -S "$socket"
printf '%s\n' '${WORKER_TUNNEL_READY_MARKER}'
trap 'exit 0' HUP INT TERM
while :; do sleep 3600; done
`;

const REMOTE_SOCKET_CLEANUP_SCRIPT = String.raw`set -eu
socket=$1
directory=$2
rm -f -- "$socket"
rmdir -- "$directory" 2>/dev/null || true
`;

type WorkerTunnelStartRequest = WorkerTunnelRequest & {
  gateway: { host: "127.0.0.1" | "::1"; port: number };
  ssh: WorkerSshEndpoint;
  resolveIdentity: WorkerSshIdentityResolver;
};

type TunnelEntry = {
  environmentId: string;
  ownerEpoch: number;
  gateway: WorkerTunnelStartRequest["gateway"];
  remoteDirectory: string;
  remoteSocketPath: string;
  abortController: AbortController;
  status: Exclude<WorkerTunnelStatus, "stopped">;
  prepared?: PreparedWorkerSsh;
  process?: WorkerSshProcess;
  initialization?: Promise<void>;
  loop?: Promise<void>;
  stopPromise?: Promise<void>;
  ready: Promise<WorkerTunnelHandle>;
  resolveReady: (handle: WorkerTunnelHandle) => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  workspaceTasks: Set<Promise<unknown>>;
};

type WorkerTunnelManagerOptions = {
  runner?: WorkerSshRunner;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  backoff?: BackoffPolicy;
  now?: () => number;
  stableConnectionMs?: number;
};

function success(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

function validateStartRequest(request: WorkerTunnelStartRequest): void {
  if (!request.environmentId.trim()) {
    throw new Error("Worker tunnel environment id must be non-empty");
  }
  if (!Number.isSafeInteger(request.ownerEpoch) || request.ownerEpoch < 0) {
    throw new Error("Worker tunnel owner epoch must be a non-negative safe integer");
  }
  if (
    !Number.isInteger(request.gateway.port) ||
    request.gateway.port < 1 ||
    request.gateway.port > 65_535
  ) {
    throw new Error("Worker tunnel gateway port must be an integer between 1 and 65535");
  }
}

function remoteTargetHost(host: WorkerTunnelStartRequest["gateway"]["host"]): string {
  return host === "::1" ? `[${host}]` : host;
}

/** Owns process-local reverse tunnels and fences all delayed work on stop or owner replacement. */
export function createWorkerTunnelManager(options: WorkerTunnelManagerOptions = {}) {
  const runner = options.runner ?? createWorkerSshRunner();
  const sleep = options.sleep ?? sleepWithAbort;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const now = options.now ?? Date.now;
  const stableConnectionMs = options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS;
  const entries = new Map<string, TunnelEntry>();
  const claimedOwnerEpochs = new Map<string, number>();

  const isCurrent = (entry: TunnelEntry) =>
    entries.get(entry.environmentId) === entry && !entry.abortController.signal.aborted;

  const sshCommand = (
    prepared: PreparedWorkerSsh,
    params: { input: string; remoteArgs: readonly string[]; signal?: AbortSignal },
  ) => ({
    argv: [
      "ssh",
      ...workerSshOptions(prepared, { forwarding: "disabled" as const }),
      "-a",
      "-x",
      "-T",
      "-p",
      String(prepared.port),
      "--",
      prepared.sshTarget,
      workerSshRemoteCommand(["sh", "-s", "--", ...params.remoteArgs]),
    ],
    options: workerSshCommandOptions({
      input: params.input,
      timeoutMs: REMOTE_SETUP_TIMEOUT_MS,
      signal: params.signal,
    }),
  });

  const prepareRemoteSocket = async (entry: TunnelEntry) => {
    const prepared = entry.prepared;
    if (!prepared) {
      throw new Error("Worker tunnel SSH context is unavailable");
    }
    const command = sshCommand(prepared, {
      input: REMOTE_SOCKET_SETUP_SCRIPT,
      remoteArgs: [entry.remoteDirectory, entry.remoteSocketPath],
      signal: entry.abortController.signal,
    });
    const result = await runner.run(command.argv, command.options);
    if (!success(result)) {
      throw workerSshProcessError(result.stderr || result.stdout);
    }
  };

  const cleanupRemoteSocket = async (entry: TunnelEntry) => {
    if (!entry.prepared) {
      return;
    }
    const command = sshCommand(entry.prepared, {
      input: REMOTE_SOCKET_CLEANUP_SCRIPT,
      remoteArgs: [entry.remoteSocketPath, entry.remoteDirectory],
    });
    await runner.run(command.argv, command.options).catch(() => undefined);
  };

  const createHandle = (entry: TunnelEntry): WorkerTunnelHandle => ({
    environmentId: entry.environmentId,
    ownerEpoch: entry.ownerEpoch,
    remoteSocketPath: entry.remoteSocketPath,
    ...createWorkerWorkspaceActions({
      environmentId: entry.environmentId,
      ownerSignal: entry.abortController.signal,
      isConnected: () => isCurrent(entry) && entry.status === "connected",
      getPrepared: () => entry.prepared,
      runner,
      tasks: entry.workspaceTasks,
    }),
    stop: () => stop(entry.environmentId, entry.ownerEpoch),
  });

  const connect = async (entry: TunnelEntry): Promise<WorkerSshProcess> => {
    const prepared = entry.prepared;
    if (!prepared) {
      throw new Error("Worker tunnel SSH context is unavailable");
    }
    await prepareRemoteSocket(entry);
    if (!isCurrent(entry)) {
      throw new Error("Worker tunnel owner changed during connection");
    }
    const target = `${remoteTargetHost(entry.gateway.host)}:${entry.gateway.port}`;
    return runner.start(
      [
        "ssh",
        ...workerSshOptions(prepared, { forwarding: "explicit" }),
        "-a",
        "-x",
        "-T",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "StreamLocalBindMask=0177",
        "-o",
        "StreamLocalBindUnlink=yes",
        "-R",
        `${entry.remoteSocketPath}:${target}`,
        "-p",
        String(prepared.port),
        "--",
        prepared.sshTarget,
        workerSshRemoteCommand(["sh", "-s", "--", entry.remoteSocketPath]),
      ],
      workerSshCommandOptions({
        input: REMOTE_TUNNEL_READY_SCRIPT,
        timeoutMs: Number.MAX_SAFE_INTEGER,
        signal: entry.abortController.signal,
      }),
    );
  };

  const reconnectLoop = async (entry: TunnelEntry) => {
    const reconnectSupervisor = new RetrySupervisor(backoff);
    while (isCurrent(entry)) {
      entry.status = reconnectSupervisor.attempts === 0 ? "connecting" : "reconnecting";
      let child: WorkerSshProcess | undefined;
      try {
        child = await connect(entry);
        entry.process = child;
        await child.ready;
        if (!isCurrent(entry)) {
          await child.stop();
          return;
        }
        entry.status = "connected";
        if (!entry.readySettled) {
          entry.readySettled = true;
          entry.resolveReady(createHandle(entry));
        }
        const connectedAtMs = now();
        await child.exited;
        if (now() - connectedAtMs >= stableConnectionMs) {
          reconnectSupervisor.reset();
        }
      } catch {
        await child?.stop().catch(() => undefined);
      } finally {
        if (entry.process === child) {
          entry.process = undefined;
        }
      }
      if (!isCurrent(entry)) {
        return;
      }
      entry.status = "reconnecting";
      try {
        const retry = reconnectSupervisor.next(entry.abortController.signal)!;
        await sleep(retry.delayMs, retry.signal);
      } catch {
        return;
      }
    }
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
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(new Error("Worker tunnel stopped before connecting"));
      }
      await entry.process?.stop().catch(() => undefined);
      await entry.initialization?.catch(() => undefined);
      await entry.process?.stop().catch(() => undefined);
      await Promise.allSettled(entry.workspaceTasks);
      await entry.loop?.catch(() => undefined);
      await cleanupRemoteSocket(entry);
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
        return await current.ready;
      }
    }

    let resolveReady!: (handle: WorkerTunnelHandle) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<WorkerTunnelHandle>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const environmentKey = stableWorkerPathComponent(request.environmentId, 16);
    const remoteDirectory = `/tmp/ocw-${environmentKey}-${request.ownerEpoch}`;
    const entry: TunnelEntry = {
      environmentId: request.environmentId,
      ownerEpoch: request.ownerEpoch,
      gateway: request.gateway,
      remoteDirectory,
      remoteSocketPath: `${remoteDirectory}/${REMOTE_SOCKET_NAME}`,
      abortController: new AbortController(),
      status: "connecting",
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      workspaceTasks: new Set(),
    };
    // Publish the new epoch before any teardown await. Stop/drain always sees the newest owner and
    // can fence its initialization even while the previous epoch is still shutting down.
    entries.set(request.environmentId, entry);
    entry.initialization = (async () => {
      if (current) {
        await stopEntry(current);
      }
      if (!isCurrent(entry)) {
        return;
      }
      entry.prepared = await prepareWorkerSsh({
        ssh: request.ssh,
        pinnedHostKey: request.ssh.hostKey,
        resolveIdentity: request.resolveIdentity,
        temporaryDirectoryPrefix: "openclaw-worker-tunnel-",
      });
      if (!isCurrent(entry)) {
        await entry.prepared.dispose();
        entry.prepared = undefined;
        return;
      }
      entry.loop = reconnectLoop(entry);
      void entry.loop.catch((error: unknown) => {
        if (!entry.readySettled) {
          entry.readySettled = true;
          entry.rejectReady(error instanceof Error ? error : new Error("Worker tunnel failed"));
        }
      });
    })();
    void entry.initialization.catch((error: unknown) => {
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(error instanceof Error ? error : new Error("Worker tunnel failed"));
      }
      void stopEntry(entry);
    });
    return await entry.ready;
  }

  async function stop(environmentId: string, ownerEpoch?: number): Promise<void> {
    const entry = entries.get(environmentId);
    if (!entry || (ownerEpoch !== undefined && ownerEpoch !== entry.ownerEpoch)) {
      return;
    }
    await stopEntry(entry);
  }

  async function stopAll(): Promise<void> {
    const current = [...entries.values()];
    for (const entry of current) {
      entries.delete(entry.environmentId);
      entry.abortController.abort(new Error("Worker tunnel manager stopped"));
    }
    await Promise.all(current.map(stopEntry));
  }

  return {
    start,
    stop,
    stopAll,
    status(environmentId: string): WorkerTunnelStatus {
      return entries.get(environmentId)?.status ?? "stopped";
    },
  };
}

export type WorkerTunnelManager = ReturnType<typeof createWorkerTunnelManager>;
