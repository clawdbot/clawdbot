import { RetrySupervisor } from "../../../packages/retry/src/index.js";
import { sleepWithAbort, type BackoffPolicy } from "../../infra/backoff.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import type { SpawnResult } from "../../process/exec.js";
import { createDeferred, type Deferred } from "../../shared/deferred.js";
import { createWorkerDesktopTunnels } from "./desktop-tunnel.js";
import {
  advanceWorkerSshAfterTransportExit,
  prepareWorkerSsh,
  type PreparedWorkerSsh,
  runWorkerSshCandidates,
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
import { boundedWorkerError } from "./worker-error.js";
import { stableWorkerPathComponent } from "./workspace-sync-helpers.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

export type { WorkerTunnelHandle } from "./tunnel-contract.js";
const REMOTE_SOCKET_NAME = "gateway.sock";
const REMOTE_SETUP_TIMEOUT_MS = 20_000;
// A live SSH process without the remote marker is not a usable tunnel. Bound each attempt so the
// retry supervisor can move on instead of pinning the environment forever.
const TUNNEL_READY_TIMEOUT_MS = 60_000;
const DEFAULT_STABLE_CONNECTION_MS = 30_000;
const DEFAULT_BACKOFF: BackoffPolicy = {
  initialMs: 250,
  maxMs: 30_000,
  factor: 2,
  jitter: 0,
};
const tunnelLog = createSubsystemLogger("gateway/worker-tunnel");

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
chmod 700 "$directory"  # no "--": BSD/macOS chmod treats it as a filename; path is script-owned and absolute
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
  bundleHash: string;
  gateway: { host: "127.0.0.1" | "::1"; port: number };
  ssh: WorkerSshEndpoint;
  sharedHost?: boolean;
  resolveIdentity: WorkerSshIdentityResolver;
};

type TunnelEntry = {
  bundleHash: string;
  environmentId: string;
  ownerEpoch: number;
  gateway: WorkerTunnelStartRequest["gateway"];
  sharedHost: boolean;
  remoteDirectory: string;
  remoteSocketPath: string;
  abortController: AbortController;
  status: Exclude<WorkerTunnelStatus, "stopped">;
  prepared?: PreparedWorkerSsh;
  process?: WorkerSshProcess;
  initialization?: Promise<void>;
  loop?: Promise<void>;
  loopSettled: boolean;
  stopPromise?: Promise<void>;
  readiness: Deferred<WorkerTunnelHandle>;
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
  const desktop = createWorkerDesktopTunnels({ runner, now });
  const entries = new Map<string, TunnelEntry>();
  const claimedOwnerEpochs = new Map<string, number>();

  const isCurrent = (entry: TunnelEntry) =>
    entries.get(entry.environmentId) === entry && !entry.abortController.signal.aborted;

  const sshCommand = (
    prepared: PreparedWorkerSsh,
    params: {
      input: string;
      port: number;
      remoteArgs: readonly string[];
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ) => ({
    argv: [
      "ssh",
      ...workerSshOptions(prepared, { forwarding: "disabled" as const }),
      "-a",
      "-x",
      "-T",
      "-p",
      String(params.port),
      "--",
      prepared.sshTarget,
      workerSshRemoteCommand(["sh", "-s", "--", ...params.remoteArgs]),
    ],
    options: workerSshCommandOptions({
      input: params.input,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    }),
  });

  const prepareRemoteSocket = async (entry: TunnelEntry) => {
    const prepared = entry.prepared;
    if (!prepared) {
      throw new Error("Worker tunnel SSH context is unavailable");
    }
    const result = await runWorkerSshCandidates(
      prepared,
      REMOTE_SETUP_TIMEOUT_MS,
      async (port, remainingTimeoutMs) => {
        const command = sshCommand(prepared, {
          input: REMOTE_SOCKET_SETUP_SCRIPT,
          port,
          remoteArgs: [entry.remoteDirectory, entry.remoteSocketPath],
          timeoutMs: remainingTimeoutMs,
          signal: entry.abortController.signal,
        });
        return await runner.run(command.argv, command.options);
      },
    );
    if (!success(result)) {
      throw workerSshProcessError(result.stderr || result.stdout);
    }
  };

  const cleanupRemoteSocket = async (entry: TunnelEntry) => {
    const prepared = entry.prepared;
    if (!prepared) {
      return;
    }
    await runWorkerSshCandidates(
      prepared,
      REMOTE_SETUP_TIMEOUT_MS,
      async (port, remainingTimeoutMs) => {
        const command = sshCommand(prepared, {
          input: REMOTE_SOCKET_CLEANUP_SCRIPT,
          port,
          remoteArgs: [entry.remoteSocketPath, entry.remoteDirectory],
          timeoutMs: remainingTimeoutMs,
        });
        return await runner.run(command.argv, command.options);
      },
    ).catch(() => undefined);
  };

  const createHandle = (entry: TunnelEntry): WorkerTunnelHandle => ({
    environmentId: entry.environmentId,
    ownerEpoch: entry.ownerEpoch,
    remoteSocketPath: entry.remoteSocketPath,
    ...createWorkerWorkspaceActions({
      environmentId: entry.environmentId,
      sharedHost: entry.sharedHost,
      ownerSignal: entry.abortController.signal,
      isConnected: () => isCurrent(entry) && entry.status === "connected",
      getPrepared: () => entry.prepared,
      runner,
      tasks: entry.workspaceTasks,
      bundleHash: entry.bundleHash,
    }),
    stop: () => stop(entry.environmentId, entry.ownerEpoch),
  });

  const connect = async (
    entry: TunnelEntry,
  ): Promise<{ port: number; process: WorkerSshProcess }> => {
    const prepared = entry.prepared;
    if (!prepared) {
      throw new Error("Worker tunnel SSH context is unavailable");
    }
    await prepareRemoteSocket(entry);
    if (!isCurrent(entry)) {
      throw new Error("Worker tunnel owner changed during connection");
    }
    const target = `${remoteTargetHost(entry.gateway.host)}:${entry.gateway.port}`;
    const port = prepared.port;
    const process = runner.start(
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
        String(port),
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
    return { port, process };
  };

  const reconnectLoop = async (entry: TunnelEntry) => {
    const reconnectSupervisor = new RetrySupervisor(backoff);
    while (isCurrent(entry)) {
      entry.status = reconnectSupervisor.attempts === 0 ? "connecting" : "reconnecting";
      let child: WorkerSshProcess | undefined;
      let childPort: number | undefined;
      try {
        const connection = await connect(entry);
        child = connection.process;
        childPort = connection.port;
        entry.process = child;
        await withTimeout(child.ready, TUNNEL_READY_TIMEOUT_MS, {
          message: "Worker tunnel did not become ready within 60 seconds",
        });
        if (!isCurrent(entry)) {
          await child.stop();
          return;
        }
        entry.status = "connected";
        const connectionReadiness = entry.readiness;
        connectionReadiness.resolve(createHandle(entry));
        const connectedAtMs = now();
        const exit = await child.exited.finally(() => {
          if (isCurrent(entry) && entry.readiness === connectionReadiness) {
            // Each established child owns one readiness barrier. Replace it as soon as that child
            // is lost so same-owner callers wait for the reconnect instead of using a stale handle.
            entry.status = "reconnecting";
            const readiness = createDeferred<WorkerTunnelHandle>();
            void readiness.promise.catch(() => undefined);
            entry.readiness = readiness;
          }
        });
        if (entry.prepared) {
          advanceWorkerSshAfterTransportExit(entry.prepared, childPort, exit);
        }
        if (now() - connectedAtMs >= stableConnectionMs) {
          reconnectSupervisor.reset();
        }
      } catch (error) {
        if (child && childPort !== undefined) {
          let stopError: unknown;
          let stopFailed = false;
          const stopping = child.stop().catch((failure: unknown) => {
            stopFailed = true;
            stopError = failure;
          });
          let exit = await Promise.race([
            child.exited.catch(() => undefined),
            stopping.then(() => undefined),
          ]);
          await stopping;
          if (stopFailed) {
            // A failed stop means the SSH child may still be running. Never drop it from
            // tracking and never retry over it — wait for its real exit first, and keep
            // that late exit so transport-exit port rotation still advances.
            tunnelLog.warn("worker tunnel stop failed; waiting for SSH child exit", {
              environmentId: entry.environmentId,
              error: boundedWorkerError(stopError),
              connectError: boundedWorkerError(error),
            });
            exit = (await child.exited.catch(() => undefined)) ?? exit;
          }
          if (exit && entry.prepared) {
            advanceWorkerSshAfterTransportExit(entry.prepared, childPort, exit);
          }
        }
        if (isCurrent(entry)) {
          tunnelLog.warn("worker tunnel connect attempt failed", {
            environmentId: entry.environmentId,
            attempt: reconnectSupervisor.attempts + 1,
            error: boundedWorkerError(error),
          });
        }
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
      entry.readiness.reject(new Error("Worker tunnel stopped before connecting"));
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
        return await current.readiness.promise;
      }
    }

    const environmentKey = stableWorkerPathComponent(request.environmentId, 16);
    const remoteDirectory = `/tmp/ocw-${environmentKey}-${request.ownerEpoch}`;
    const readiness = createDeferred<WorkerTunnelHandle>();
    void readiness.promise.catch(() => undefined);
    const entry: TunnelEntry = {
      environmentId: request.environmentId,
      bundleHash: request.bundleHash,
      ownerEpoch: request.ownerEpoch,
      gateway: request.gateway,
      sharedHost: request.sharedHost === true,
      remoteDirectory,
      remoteSocketPath: `${remoteDirectory}/${REMOTE_SOCKET_NAME}`,
      abortController: new AbortController(),
      status: "connecting",
      loopSettled: false,
      readiness,
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
      entry.loop = reconnectLoop(entry).finally(() => {
        entry.loopSettled = true;
      });
      void entry.loop.catch((error: unknown) => {
        entry.readiness.reject(error instanceof Error ? error : new Error("Worker tunnel failed"));
      });
    })();
    void entry.initialization.catch((error: unknown) => {
      entry.readiness.reject(error instanceof Error ? error : new Error("Worker tunnel failed"));
      void stopEntry(entry);
    });
    return await entry.readiness.promise;
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
    for (const entry of current) {
      entries.delete(entry.environmentId);
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
      const entry = entries.get(environmentId);
      return !entry || entry.loopSettled ? "stopped" : entry.status;
    },
  };
}

export type WorkerTunnelManager = ReturnType<typeof createWorkerTunnelManager>;
