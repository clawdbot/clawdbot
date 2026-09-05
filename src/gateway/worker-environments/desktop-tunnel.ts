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

  const appLaunchKey = (environmentId: string, appId: WorkerDesktopApp["id"]) =>
    `${environmentId}\0${appId}`;

  const stopAppLaunches = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    const matching = [...appLaunches.values()].filter(
      (entry) =>
        entry.environmentId === environmentId &&
        (ownerEpoch === undefined || entry.ownerEpoch === ownerEpoch),
    );
    for (const entry of matching) {
      entry.abortController.abort(new Error("Worker desktop app launch owner stopped"));
    }
    await Promise.allSettled(matching.map((entry) => entry.operation));
  };

  const claimOwnerEpoch = (environmentId: string, ownerEpoch: number): boolean => {
    try {
      return sessions.claimOwnerEpoch(environmentId, ownerEpoch);
    } catch (error) {
      if (error instanceof DesktopSessionStaleOwnerError) {
        throw new Error("Worker desktop owner epoch is stale", { cause: error });
      }
      throw error;
    }
  };

  const fenceReplacedOwners = async (environmentId: string, ownerEpoch: number): Promise<void> => {
    await sessions.stopSuperseded(environmentId, ownerEpoch);
    const staleLaunches = [...appLaunches.values()].filter(
      (entry) => entry.environmentId === environmentId && entry.ownerEpoch < ownerEpoch,
    );
    for (const entry of staleLaunches) {
      entry.abortController.abort(new Error("Worker desktop app launch owner replaced"));
    }
    await Promise.allSettled(staleLaunches.map((entry) => entry.operation));
  };

  const createSessionHooks = (request: DesktopAcquireRequest) => {
    let prepared: PreparedWorkerSsh | undefined;
    let child: WorkerSshProcess | undefined;
    let stoppedChild: WorkerSshProcess | undefined;
    let startSettled = false;

    const start = async (isCurrent: () => boolean): Promise<DesktopAcquireResult> => {
      try {
        prepared = await prepareWorkerSsh({
          ssh: request.ssh,
          pinnedHostKey: request.ssh.hostKey,
          resolveIdentity: request.resolveIdentity,
          // macOS Unix sockets allow 103 bytes; share one short private directory with SSH credentials.
          temporaryDirectoryPrefix: "/tmp/openclaw-worker-desktop-",
        });
        if (!isCurrent()) {
          await prepared.dispose();
          prepared = undefined;
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
        const startedChild = child;
        void startedChild.exited.then(() => {
          if (isCurrent()) {
            void sessions.stop(request.environmentId, request.ownerEpoch);
          }
        });
        await startedChild.ready;
        if (!isCurrent()) {
          await startedChild.stop();
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
      } finally {
        startSettled = true;
      }
    };

    const teardown = async (): Promise<void> => {
      if (child && child !== stoppedChild) {
        stoppedChild = child;
        await child.stop().catch(() => undefined);
      }
      if (!startSettled) {
        return;
      }
      if (child && child !== stoppedChild) {
        stoppedChild = child;
        await child?.stop().catch(() => undefined);
      }
      await prepared?.dispose().catch(() => undefined);
      prepared = undefined;
    };

    return { start, teardown };
  };

  async function acquire(request: DesktopAcquireRequest): Promise<DesktopAcquireResult> {
    if (platform === "win32") {
      throw new WorkerDesktopUnsupportedError();
    }
    const ownerAdvanced = claimOwnerEpoch(request.environmentId, request.ownerEpoch);
    if (ownerAdvanced) {
      await fenceReplacedOwners(request.environmentId, request.ownerEpoch);
    }
    if (!sessions.isOwnerEpochCurrent(request.environmentId, request.ownerEpoch)) {
      throw new Error("Worker desktop owner epoch is stale");
    }
    const hooks = createSessionHooks(request);
    try {
      return await sessions.acquire({
        sourceKey: request.environmentId,
        ownerEpoch: request.ownerEpoch,
        ...hooks,
      });
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
      ownerAdvanced = claimOwnerEpoch(request.environmentId, request.ownerEpoch);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("Worker desktop owner epoch is invalid", { cause: error }),
      );
    }
    const key = appLaunchKey(request.environmentId, request.app.id);
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
        await fenceReplacedOwners(request.environmentId, request.ownerEpoch);
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
    await Promise.all([
      sessions.stop(environmentId, ownerEpoch),
      stopAppLaunches(environmentId, ownerEpoch),
    ]);
  }

  async function stopAll(): Promise<void> {
    for (const entry of appLaunches.values()) {
      entry.abortController.abort(new Error("Worker desktop app launcher stopped"));
    }
    await Promise.all([
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
