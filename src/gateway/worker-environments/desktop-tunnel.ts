import path from "node:path";
import { withTimeout } from "../../infra/fs-safe.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type {
  WorkerDesktopApp,
  WorkerDesktopEndpoint,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
import type { DesktopRfbAttachment } from "../desktop/attachment.js";
import {
  createDesktopSessionRegistry,
  DesktopSessionStaleOwnerError,
  DesktopSessionStoppedError,
  type DesktopSessionRegistry,
} from "../desktop/session-registry.js";
import {
  prepareWorkerSsh,
  type PreparedWorkerSsh,
  type WorkerSshIdentityResolver,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "./ssh.js";
import { joinWorkerTunnelStops } from "./tunnel-contract.js";
import {
  type WorkerSshProcess,
  type WorkerSshRunner,
  workerSshProcessError,
  WORKER_TUNNEL_READY_MARKER,
} from "./tunnel-ssh-runner.js";

const PASSWORD_READ_TIMEOUT_MS = 20_000;
const APP_LAUNCH_TIMEOUT_MS = 30_000;

const REMOTE_DESKTOP_READY_SCRIPT = String.raw`set -eu
printf '%s\n' '${WORKER_TUNNEL_READY_MARKER}'
trap 'exit 0' HUP INT TERM
while :; do sleep 3600; done
`;

type DesktopAcquireRequest = {
  environmentId: string;
  ownerEpoch: number;
  ssh: WorkerSshEndpoint;
  desktop: WorkerDesktopEndpoint;
  resolveIdentity: WorkerSshIdentityResolver;
};

type DesktopAcquireResult = { attachment: DesktopRfbAttachment; vncPassword?: string };

type DesktopAppLaunchEntry = {
  environmentId: string;
  appId: WorkerDesktopApp["id"];
  ownerEpoch: number;
  abortController: AbortController;
  operation: Promise<void>;
};

class WorkerDesktopUnsupportedError extends Error {
  readonly code = "unsupported_platform";

  constructor(operation = "desktop observe") {
    super(`${operation} is not supported on Windows gateway hosts`);
    this.name = "WorkerDesktopUnsupportedError";
  }
}

function successful(result: Awaited<ReturnType<WorkerSshRunner["run"]>>): boolean {
  return result.termination === "exit" && result.code === 0;
}

/** Owns worker-specific desktop SSH acquisition and app launch processes. */
export function createWorkerDesktopTunnels(deps: {
  runner: WorkerSshRunner;
  registry?: DesktopSessionRegistry;
  lingerMs?: number;
  platform?: NodeJS.Platform;
}) {
  const platform = deps.platform ?? process.platform;
  const sessions = deps.registry ?? createDesktopSessionRegistry({ lingerMs: deps.lingerMs });
  const appLaunches = new Map<string, DesktopAppLaunchEntry>();

  const stopAppLaunches = async (
    matches: (entry: DesktopAppLaunchEntry) => boolean,
    reason: "stopped" | "replaced",
  ): Promise<void> => {
    const matching = [...appLaunches.values()].filter(matches);
    for (const entry of matching) {
      entry.abortController.abort(new Error(`Worker desktop app launch owner ${reason}`));
    }
    await Promise.allSettled(matching.map((entry) => entry.operation));
  };

  const stopReplacedAppLaunches = (environmentId: string, ownerEpoch: number) =>
    stopAppLaunches(
      (entry) => entry.environmentId === environmentId && entry.ownerEpoch < ownerEpoch,
      "replaced",
    );

  const createSessionHooks = (request: DesktopAcquireRequest) => {
    let prepared: PreparedWorkerSsh | undefined;
    let child: WorkerSshProcess | undefined;

    const start = async (
      isCurrent: () => boolean,
      stopOwner: () => Promise<void>,
    ): Promise<DesktopAcquireResult> => {
      if (!isCurrent()) {
        throw new Error("Worker desktop tunnel stopped before connecting");
      }
      prepared = await prepareWorkerSsh({
        ssh: request.ssh,
        pinnedHostKey: request.ssh.hostKey,
        resolveIdentity: request.resolveIdentity,
        // macOS Unix sockets allow 103 bytes; share one short private directory with SSH credentials.
        temporaryDirectoryPrefix: "/tmp/openclaw-worker-desktop-",
      });
      if (!isCurrent()) {
        throw new Error("Worker desktop tunnel stopped before connecting");
      }
      const localSocketPath = path.join(path.dirname(prepared.knownHostsPath), "desktop.sock");
      child = deps.runner.start(
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
          "-L",
          `${localSocketPath}:127.0.0.1:${request.desktop.port}`,
          "-p",
          String(prepared.port),
          "--",
          prepared.sshTarget,
          workerSshRemoteCommand(["sh", "-s"]),
        ],
        workerSshCommandOptions({
          input: REMOTE_DESKTOP_READY_SCRIPT,
          timeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      );
      void child.exited.then(() => {
        void stopOwner();
      });
      await child.ready;
      if (!isCurrent()) {
        throw new Error("Worker desktop tunnel stopped before connecting");
      }
      let vncPassword: string | undefined;
      if (request.desktop.passwordFilePath) {
        const result = await deps.runner.run(
          [
            "ssh",
            ...workerSshOptions(prepared, { forwarding: "disabled" }),
            "-a",
            "-x",
            "-T",
            "-p",
            String(prepared.port),
            "--",
            prepared.sshTarget,
            workerSshRemoteCommand(["cat", request.desktop.passwordFilePath]),
          ],
          workerSshCommandOptions({ timeoutMs: PASSWORD_READ_TIMEOUT_MS }),
        );
        if (!successful(result)) {
          throw workerSshProcessError(result.stderr || result.stdout);
        }
        vncPassword = result.stdout.replace(/(?:\r?\n)+$/u, "");
        if (!vncPassword) {
          throw new Error("Worker desktop password file is empty");
        }
        registerSecretValueForRedaction(vncPassword);
      }
      return {
        attachment: { kind: "unix-socket", socketPath: localSocketPath },
        ...(vncPassword ? { vncPassword } : {}),
      };
    };

    return {
      start,
      teardown: async () => {
        await child?.stop();
      },
      dispose: async () => {
        await prepared?.dispose();
      },
    };
  };

  async function acquire(request: DesktopAcquireRequest): Promise<DesktopAcquireResult> {
    if (platform === "win32") {
      throw new WorkerDesktopUnsupportedError();
    }
    const hooks = createSessionHooks(request);
    try {
      sessions.claimOwnerEpoch(request.environmentId, request.ownerEpoch);
      // Register before abort callbacks can reenter Stop; the registry defers source startup.
      const acquiring = sessions.acquire({
        sourceKey: request.environmentId,
        ownerEpoch: request.ownerEpoch,
        ...hooks,
        start: async (isCurrent, stopOwner) => {
          await fencing;
          return await hooks.start(isCurrent, stopOwner);
        },
      });
      const fencing = stopReplacedAppLaunches(request.environmentId, request.ownerEpoch);
      await joinWorkerTunnelStops([acquiring.then(() => undefined), fencing]);
      return await acquiring;
    } catch (error) {
      if (error instanceof DesktopSessionStaleOwnerError) {
        throw new Error("Worker desktop owner epoch is stale", { cause: error });
      }
      if (error instanceof DesktopSessionStoppedError) {
        throw new Error("Worker desktop tunnel stopped before connecting", { cause: error });
      }
      throw error;
    }
  }

  function launchApp(request: {
    environmentId: string;
    ownerEpoch: number;
    ssh: WorkerSshEndpoint;
    app: WorkerDesktopApp;
    resolveIdentity: WorkerSshIdentityResolver;
  }): Promise<void> {
    if (platform === "win32") {
      return Promise.reject(new WorkerDesktopUnsupportedError("desktop app launch"));
    }
    let ownerAdvanced: boolean;
    try {
      ownerAdvanced = sessions.claimOwnerEpoch(request.environmentId, request.ownerEpoch);
    } catch (error) {
      if (error instanceof DesktopSessionStaleOwnerError) {
        return Promise.reject(new Error("Worker desktop owner epoch is stale", { cause: error }));
      }
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Worker desktop owner epoch is invalid", { cause: error }),
      );
    }
    const key = `${request.environmentId}\0${request.app.id}`;
    const current = appLaunches.get(key);
    if (current?.ownerEpoch === request.ownerEpoch) {
      return current.operation;
    }
    const abortController = new AbortController();
    const startedAtMs = Date.now();
    let startExecution!: () => void;
    const startGate = new Promise<void>((resolve) => {
      startExecution = resolve;
    });
    const execution = (async () => {
      await startGate;
      abortController.signal.throwIfAborted();
      if (!sessions.isOwnerEpochCurrent(request.environmentId, request.ownerEpoch)) {
        throw new Error("Worker desktop app launch owner was replaced");
      }
      if (current) {
        current.abortController.abort(new Error("Worker desktop app launch owner replaced"));
        await current.operation.catch(() => undefined);
      }
      if (ownerAdvanced) {
        await joinWorkerTunnelStops([
          sessions.stopSuperseded(request.environmentId, request.ownerEpoch),
          stopReplacedAppLaunches(request.environmentId, request.ownerEpoch),
        ]);
      }
      abortController.signal.throwIfAborted();
      const prepared = await prepareWorkerSsh({
        ssh: request.ssh,
        pinnedHostKey: request.ssh.hostKey,
        resolveIdentity: request.resolveIdentity,
        temporaryDirectoryPrefix: "openclaw-worker-desktop-app-",
      });
      try {
        abortController.signal.throwIfAborted();
        const remainingLaunchMs = Math.max(0, APP_LAUNCH_TIMEOUT_MS - (Date.now() - startedAtMs));
        // Launchers are stateful: SSH exit 255 cannot prove the remote app did not start.
        // Use the lifecycle-selected port once so an ambiguous disconnect cannot launch twice.
        const result = await deps.runner.run(
          [
            "ssh",
            ...workerSshOptions(prepared, { forwarding: "disabled" }),
            "-a",
            "-x",
            "-T",
            "-p",
            String(prepared.port),
            "--",
            prepared.sshTarget,
            workerSshRemoteCommand([request.app.executablePath]),
          ],
          workerSshCommandOptions({
            timeoutMs: remainingLaunchMs,
            signal: abortController.signal,
          }),
        );
        if (!successful(result)) {
          throw workerSshProcessError(result.stderr || result.stdout);
        }
      } finally {
        await prepared.dispose();
      }
    })();
    const timeoutError = new Error("Worker desktop app launcher timed out after 30 seconds");
    const operation = withTimeout(execution, APP_LAUNCH_TIMEOUT_MS, {
      createError: () => timeoutError,
    }).catch((error: unknown) => {
      if (error === timeoutError) {
        abortController.abort(timeoutError);
      }
      throw error;
    });
    const completeEntry: DesktopAppLaunchEntry = {
      environmentId: request.environmentId,
      appId: request.app.id,
      ownerEpoch: request.ownerEpoch,
      abortController,
      operation,
    };
    appLaunches.set(key, completeEntry);
    // The pending owner is now visible to teardown; only then may identity resolution or SSH run.
    startExecution();
    void operation
      .finally(() => {
        if (appLaunches.get(key) === completeEntry) {
          appLaunches.delete(key);
        }
      })
      .catch(() => undefined);
    return operation;
  }

  async function stop(environmentId: string, ownerEpoch?: number): Promise<void> {
    await joinWorkerTunnelStops([
      sessions.stop(environmentId, ownerEpoch),
      stopAppLaunches(
        (entry) =>
          entry.environmentId === environmentId &&
          (ownerEpoch === undefined || entry.ownerEpoch === ownerEpoch),
        "stopped",
      ),
    ]);
  }

  async function stopAll(): Promise<void> {
    for (const entry of appLaunches.values()) {
      entry.abortController.abort(new Error("Worker desktop app launcher stopped"));
    }
    await joinWorkerTunnelStops([
      sessions.stopAll(),
      ...[...appLaunches.values()].map((entry) => entry.operation.catch(() => undefined)),
    ]);
  }

  return {
    acquire,
    attachObserver: sessions.attachObserver,
    launchApp,
    stop,
    stopAll,
  };
}
