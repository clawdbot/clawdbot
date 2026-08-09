import { hasCloudSessionRecovery } from "../lib/sessions/cloud-recovery-storage-key.ts";
import type { CloudSessionRecovery } from "../lib/sessions/cloud-recovery.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "./gateway.ts";
import type { ApplicationInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";

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

export function createApplicationCloudStartup(
  dependencies: ApplicationCloudStartupDependencies,
  loadRuntime: CloudStartupRuntimeLoader = () => import("./cloud-session-startup.runtime.ts"),
): ApplicationCloudStartup {
  const listeners = new Set<() => void>();
  let loadFailure: LoadFailure | null = null;
  let runtime: ApplicationCloudStartupRuntime | null = null;
  let runtimeLoad: Promise<ApplicationCloudStartupRuntime | null> | null = null;
  let disposed = false;

  const publish = () => {
    listeners.forEach((listener) => listener());
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
    runtimeLoad = loadRuntime()
      .then(({ createApplicationCloudStartupRuntime }) => {
        if (disposed) {
          return null;
        }
        const created = createApplicationCloudStartupRuntime(dependencies, {
          reconcileCurrentSnapshot,
        });
        runtime = created;
        created.subscribe(publish);
        if (reconcileCurrentSnapshot) {
          publish();
        }
        return created;
      })
      .catch((error: unknown) => {
        runtimeLoad = null;
        throw error;
      });
    return runtimeLoad;
  };

  const maybeLoadRecovery = (snapshot: ApplicationGatewaySnapshot) => {
    const recoveryScope = snapshot.client?.recoveryScope;
    if (
      runtime ||
      runtimeLoad ||
      snapshot.phase !== "connected" ||
      !snapshot.client?.recoveryScopeReady ||
      !recoveryScope ||
      !hasCloudSessionRecovery(dependencies.gateway.connection.gatewayUrl, recoveryScope)
    ) {
      return;
    }
    void ensureRuntime().catch(() => undefined);
  };

  const stopGateway = dependencies.gateway.subscribe(maybeLoadRecovery);
  maybeLoadRecovery(dependencies.gateway.snapshot);

  const start: ApplicationCloudStartup["start"] = async (input) => {
    loadFailure = null;
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
      loadFailure = {
        input,
        status: {
          sessionKey: input.recovery.sessionKey,
          phase: "failed",
          startedAt: input.createdAt,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
      publish();
    }
  };

  const retry: ApplicationCloudStartup["retry"] = async (sessionKey) => {
    if (runtime) {
      runtime.retry(sessionKey);
      return;
    }
    const failure = loadFailure;
    if (failure?.status.sessionKey === sessionKey) {
      return start(failure.input);
    }
  };

  return {
    get(sessionKey) {
      return (
        runtime?.get(sessionKey) ??
        (loadFailure?.status.sessionKey === sessionKey ? loadFailure.status : null)
      );
    },
    start,
    retry,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      stopGateway();
      runtime?.dispose();
      runtime = null;
      runtimeLoad = null;
      loadFailure = null;
      listeners.clear();
    },
  };
}
