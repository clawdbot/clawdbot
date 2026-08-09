import { hasCloudSessionRecovery } from "../lib/sessions/cloud-recovery-storage-key.ts";
import type { CloudSessionRecovery } from "../lib/sessions/cloud-recovery.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type {
  ApplicationGatewaySnapshot,
  ApplicationInitialUserMessageHandoff,
} from "./context.ts";
import type { ApplicationGateway } from "./gateway.ts";

export type { ApplicationInitialUserMessage } from "./context.ts";

export type ApplicationCloudStartupStatus = {
  readonly sessionKey: string;
  readonly phase:
    | "pending"
    | "requested"
    | "provisioning"
    | "syncing"
    | "starting"
    | "active"
    | "sending"
    | "failed";
  readonly startedAt: number;
  readonly error?: string;
  readonly retryable?: boolean;
};

type CloudStartupInput = {
  readonly recovery: CloudSessionRecovery;
  readonly persistRecovery: boolean;
  readonly recovering: boolean;
  readonly createdAt: number;
};

export type ApplicationCloudStartupDependencies = {
  gateway: ApplicationGateway;
  sessions: SessionCapability;
  initialUserMessage: ApplicationInitialUserMessageHandoff;
};

export type ApplicationCloudStartupRuntime = {
  get: (sessionKey: string) => ApplicationCloudStartupStatus | null;
  start: (input: CloudStartupInput) => void;
  retry: (sessionKey: string) => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

export type ApplicationCloudStartup = Omit<ApplicationCloudStartupRuntime, "start" | "retry"> & {
  start: (input: CloudStartupInput) => Promise<void>;
  retry: (sessionKey: string) => Promise<void>;
};

type CloudStartupRuntimeModule = typeof import("./cloud-session-startup.runtime.ts");
type CloudStartupRuntimeLoader = () => Promise<CloudStartupRuntimeModule>;

type LoadFailure = {
  input: CloudStartupInput;
  status: ApplicationCloudStartupStatus;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApplicationCloudStartup(
  dependencies: ApplicationCloudStartupDependencies,
  loadRuntime: CloudStartupRuntimeLoader = () => import("./cloud-session-startup.runtime.ts"),
): ApplicationCloudStartup {
  const listeners = new Set<() => void>();
  const loadFailures = new Map<string, LoadFailure>();
  let runtime: ApplicationCloudStartupRuntime | null = null;
  let runtimeLoad: Promise<ApplicationCloudStartupRuntime | null> | null = null;
  let stopRuntime: (() => void) | null = null;
  let disposed = false;

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const ensureRuntime = (
    reconcileCurrentSnapshot = true,
  ): Promise<ApplicationCloudStartupRuntime | null> => {
    if (disposed) {
      return Promise.resolve(null);
    }
    if (runtime) {
      return Promise.resolve(runtime);
    }
    if (runtimeLoad) {
      return runtimeLoad;
    }
    const pending = loadRuntime()
      .then(({ createApplicationCloudStartupRuntime }) => {
        if (disposed) {
          return null;
        }
        const created = createApplicationCloudStartupRuntime(dependencies, {
          reconcileCurrentSnapshot,
        });
        runtime = created;
        stopRuntime = created.subscribe(publish);
        if (reconcileCurrentSnapshot) {
          publish();
        }
        return created;
      })
      .catch((error: unknown) => {
        if (runtimeLoad === pending) {
          runtimeLoad = null;
        }
        throw error;
      });
    runtimeLoad = pending;
    return pending;
  };

  const maybeLoadRecovery = (snapshot: ApplicationGatewaySnapshot) => {
    if (
      disposed ||
      runtime ||
      runtimeLoad ||
      snapshot.phase !== "connected" ||
      !snapshot.client?.recoveryScopeReady ||
      !snapshot.client.recoveryScope ||
      !hasCloudSessionRecovery(
        dependencies.gateway.connection.gatewayUrl,
        snapshot.client.recoveryScope,
      )
    ) {
      return;
    }
    void ensureRuntime().catch(() => undefined);
  };

  const stopGateway = dependencies.gateway.subscribe(maybeLoadRecovery);
  maybeLoadRecovery(dependencies.gateway.snapshot);

  const start: ApplicationCloudStartup["start"] = async (input) => {
    loadFailures.delete(input.recovery.sessionKey);
    try {
      const target = await ensureRuntime(false);
      if (!target || disposed) {
        return;
      }
      target.start(input);
    } catch (error) {
      if (disposed) {
        return;
      }
      loadFailures.set(input.recovery.sessionKey, {
        input,
        status: {
          sessionKey: input.recovery.sessionKey,
          phase: "failed",
          startedAt: input.createdAt,
          error: errorMessage(error),
          retryable: true,
        },
      });
      publish();
    }
  };

  const retry: ApplicationCloudStartup["retry"] = async (sessionKey) => {
    if (disposed) {
      return;
    }
    if (runtime) {
      runtime.retry(sessionKey);
      return;
    }
    const failure = loadFailures.get(sessionKey);
    if (failure) {
      await start(failure.input);
      return;
    }
    if (runtimeLoad) {
      const target = await runtimeLoad.catch(() => null);
      target?.retry(sessionKey);
    }
  };

  return {
    get(sessionKey) {
      return runtime?.get(sessionKey) ?? loadFailures.get(sessionKey)?.status ?? null;
    },
    start,
    retry,
    subscribe(listener) {
      if (disposed) {
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      stopGateway();
      stopRuntime?.();
      runtime?.dispose();
      runtime = null;
      runtimeLoad = null;
      loadFailures.clear();
      listeners.clear();
    },
  };
}
