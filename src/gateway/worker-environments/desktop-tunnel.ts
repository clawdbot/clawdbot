import path from "node:path";
import { withTimeout } from "../../infra/fs-safe.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type {
  WorkerDesktopApp,
  WorkerDesktopEndpoint,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
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

const DEFAULT_LINGER_MS = 60_000;
const PASSWORD_READ_TIMEOUT_MS = 20_000;
const APP_LAUNCH_TIMEOUT_MS = 30_000;
const MAX_OBSERVERS = 8;

const REMOTE_DESKTOP_READY_SCRIPT = String.raw`set -eu
printf '%s\n' '${WORKER_TUNNEL_READY_MARKER}'
trap 'exit 0' HUP INT TERM
while :; do sleep 3600; done
`;

type WorkerDesktopObserver = {
  control: boolean;
  /** Epoch the observer token was minted against; a stale token must not reach a newer entry. */
  ownerEpoch: number;
  close(code: number, reason: string): void;
};

type DesktopAcquireRequest = {
  environmentId: string;
  ownerEpoch: number;
  ssh: WorkerSshEndpoint;
  desktop: WorkerDesktopEndpoint;
  resolveIdentity: WorkerSshIdentityResolver;
};

type DesktopAcquireResult = { localSocketPath: string; vncPassword?: string };
type ObserverEntry = WorkerDesktopObserver & { released: boolean };
type DesktopEntry = {
  environmentId: string;
  ownerEpoch: number;
  localSocketPath?: string;
  prepared?: PreparedWorkerSsh;
  process?: WorkerSshProcess;
  initialization?: Promise<void>;
  stopPromise?: Promise<void>;
  ready: Promise<DesktopAcquireResult>;
  resolveReady: (result: DesktopAcquireResult) => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  observers: Set<ObserverEntry>;
  controller?: ObserverEntry;
  lingerTimer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
};

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

/** Owns per-environment local desktop forwards and their connected observer lifetimes. */
export function createWorkerDesktopTunnels(deps: {
  runner: WorkerSshRunner;
  now?: () => number;
  lingerMs?: number;
  platform?: NodeJS.Platform;
}) {
  const lingerMs = deps.lingerMs ?? DEFAULT_LINGER_MS;
  const platform = deps.platform ?? process.platform;
  const entries = new Map<string, DesktopEntry>();
  const appLaunches = new Map<string, DesktopAppLaunchEntry>();
  const claimedOwnerEpochs = new Map<string, number>();

  const appLaunchKey = (environmentId: string, appId: WorkerDesktopApp["id"]) =>
    `${environmentId}\0${appId}`;

  const isCurrent = (entry: DesktopEntry) =>
    entries.get(entry.environmentId) === entry && !entry.stopped;

  const closeObserver = (observer: ObserverEntry, code: number, reason: string) => {
    try {
      observer.close(code, reason);
    } catch {
      // Observer cleanup remains authoritative when the transport close callback fails.
    }
  };

  const stopEntry = (entry: DesktopEntry): Promise<void> => {
    if (entry.stopPromise) {
      return entry.stopPromise;
    }
    entry.stopPromise = (async () => {
      entry.stopped = true;
      if (entries.get(entry.environmentId) === entry) {
        entries.delete(entry.environmentId);
      }
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = undefined;
      for (const observer of entry.observers) {
        observer.released = true;
        closeObserver(observer, 1012, "desktop tunnel closed");
      }
      entry.observers.clear();
      entry.controller = undefined;
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(new Error("Worker desktop tunnel stopped before connecting"));
      }
      const processBeforeInitialization = entry.process;
      await processBeforeInitialization?.stop().catch(() => undefined);
      await entry.initialization?.catch(() => undefined);
      if (entry.process !== processBeforeInitialization) {
        await entry.process?.stop().catch(() => undefined);
      }
      await entry.prepared?.dispose().catch(() => undefined);
    })();
    return entry.stopPromise;
  };

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

  const reserveOwnerEpoch = (environmentId: string, ownerEpoch: number): boolean => {
    const claimedEpoch = claimedOwnerEpochs.get(environmentId);
    if (claimedEpoch !== undefined && ownerEpoch < claimedEpoch) {
      throw new Error("Worker desktop owner epoch is stale");
    }
    if (claimedEpoch === undefined || ownerEpoch > claimedEpoch) {
      claimedOwnerEpochs.set(environmentId, ownerEpoch);
      return true;
    }
    return false;
  };

  const fenceReplacedOwners = async (environmentId: string, ownerEpoch: number): Promise<void> => {
    const current = entries.get(environmentId);
    if (current && current.ownerEpoch < ownerEpoch) {
      await stopEntry(current);
    }
    const staleLaunches = [...appLaunches.values()].filter(
      (entry) => entry.environmentId === environmentId && entry.ownerEpoch < ownerEpoch,
    );
    for (const entry of staleLaunches) {
      entry.abortController.abort(new Error("Worker desktop app launch owner replaced"));
    }
    await Promise.allSettled(staleLaunches.map((entry) => entry.operation));
  };

  const startEntry = async (entry: DesktopEntry, request: DesktopAcquireRequest) => {
    const prepared = await prepareWorkerSsh({
      ssh: request.ssh,
      pinnedHostKey: request.ssh.hostKey,
      resolveIdentity: request.resolveIdentity,
      temporaryDirectoryPrefix: "openclaw-worker-desktop-",
    });
    entry.prepared = prepared;
    if (!isCurrent(entry)) {
      await prepared.dispose();
      entry.prepared = undefined;
      return;
    }
    const localSocketPath = path.join(path.dirname(prepared.knownHostsPath), "desktop.sock");
    entry.localSocketPath = localSocketPath;
    const child = deps.runner.start(
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
    entry.process = child;
    void child.exited.then(() => {
      if (isCurrent(entry)) {
        void stopEntry(entry);
      }
    });
    await child.ready;
    if (!isCurrent(entry)) {
      await child.stop();
      return;
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
    entry.readySettled = true;
    entry.resolveReady({ localSocketPath, ...(vncPassword ? { vncPassword } : {}) });
  };

  async function acquire(request: DesktopAcquireRequest): Promise<DesktopAcquireResult> {
    if (platform === "win32") {
      throw new WorkerDesktopUnsupportedError();
    }
    const ownerAdvanced = reserveOwnerEpoch(request.environmentId, request.ownerEpoch);
    if (ownerAdvanced) {
      await fenceReplacedOwners(request.environmentId, request.ownerEpoch);
    }
    if (claimedOwnerEpochs.get(request.environmentId) !== request.ownerEpoch) {
      throw new Error("Worker desktop owner epoch is stale");
    }
    const current = entries.get(request.environmentId);
    if (current?.ownerEpoch === request.ownerEpoch) {
      return await current.ready;
    }
    let resolveReady!: (result: DesktopAcquireResult) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<DesktopAcquireResult>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const entry: DesktopEntry = {
      environmentId: request.environmentId,
      ownerEpoch: request.ownerEpoch,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      observers: new Set(),
      stopped: false,
    };
    entries.set(request.environmentId, entry);
    entry.initialization = (async () => {
      if (current) {
        await stopEntry(current);
      }
      if (isCurrent(entry)) {
        await startEntry(entry, request);
      }
    })();
    void entry.initialization.catch((error: unknown) => {
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(
          error instanceof Error ? error : new Error("Worker desktop tunnel failed"),
        );
      }
      void stopEntry(entry);
    });
    return await ready;
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
      ownerAdvanced = reserveOwnerEpoch(request.environmentId, request.ownerEpoch);
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
      if (claimedOwnerEpochs.get(request.environmentId) !== request.ownerEpoch) {
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

  function attachObserver(environmentId: string, observer: WorkerDesktopObserver) {
    const entry = entries.get(environmentId);
    if (!entry || !entry.readySettled || entry.stopped || entry.observers.size >= MAX_OBSERVERS) {
      return undefined;
    }
    // A token minted against a replaced entry must not reach this one; otherwise a stale
    // control token would evict the current controller of a desktop it never observed.
    if (observer.ownerEpoch !== entry.ownerEpoch) {
      return undefined;
    }
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = undefined;
    if (observer.control && entry.controller) {
      const previous = entry.controller;
      previous.released = true;
      entry.observers.delete(previous);
      entry.controller = undefined;
      closeObserver(previous, 4000, "control-taken");
    }
    const attached: ObserverEntry = { ...observer, released: false };
    entry.observers.add(attached);
    if (attached.control) {
      entry.controller = attached;
    }
    return {
      release() {
        if (attached.released) {
          return;
        }
        attached.released = true;
        entry.observers.delete(attached);
        if (entry.controller === attached) {
          entry.controller = undefined;
        }
        if (entry.observers.size === 0 && isCurrent(entry)) {
          entry.lingerTimer = setTimeout(() => void stopEntry(entry), lingerMs);
          entry.lingerTimer.unref?.();
        }
      },
    };
  }

  async function stop(environmentId: string, ownerEpoch?: number): Promise<void> {
    const entry = entries.get(environmentId);
    await Promise.all([
      entry && (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch)
        ? stopEntry(entry)
        : Promise.resolve(),
      stopAppLaunches(environmentId, ownerEpoch),
    ]);
  }

  async function stopAll(): Promise<void> {
    for (const entry of appLaunches.values()) {
      entry.abortController.abort(new Error("Worker desktop app launcher stopped"));
    }
    await Promise.all([
      ...[...entries.values()].map(stopEntry),
      ...[...appLaunches.values()].map((entry) => entry.operation.catch(() => undefined)),
    ]);
  }

  return { acquire, attachObserver, launchApp, stop, stopAll };
}

export type WorkerDesktopTunnels = ReturnType<typeof createWorkerDesktopTunnels>;
