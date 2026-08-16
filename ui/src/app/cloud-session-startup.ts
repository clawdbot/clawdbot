import { formatUiError } from "../lib/format-error.ts";
import type { CloudSessionRecovery } from "../lib/sessions/cloud-recovery.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { ApplicationGateway } from "./gateway.ts";
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

export type ApplicationCloudStartup = Omit<ApplicationCloudStartupRuntime, "start"> & {
  start: (input: CloudStartupInput) => void;
  resumeRecovery: () => void;
};

type CloudStartupRuntimeModule = typeof import("./cloud-session-startup.runtime.ts");
type CloudStartupRuntimeLoader = () => Promise<CloudStartupRuntimeModule>;

export function createApplicationCloudStartup(
  dependencies: ApplicationCloudStartupDependencies,
  loadRuntime: CloudStartupRuntimeLoader = () => import("./cloud-session-startup.runtime.ts"),
): ApplicationCloudStartup {
  const preRuntimeEntries = new Map<string, CloudStartupInput>();
  let activeDependencies: ApplicationCloudStartupDependencies | null = dependencies;
  let runtime: ApplicationCloudStartupRuntime | undefined;
  let runtimeLoad: Promise<void> | undefined;
  let runtimeError: string | undefined;
  const listeners = new Set<() => void>();

  const publish = () => listeners.forEach((listener) => listener());

  const ensureRuntime = (): Promise<void> =>
    (runtimeLoad ??= loadRuntime().then(
      ({ default: createApplicationCloudStartupRuntime }) => {
        if (!activeDependencies) {
          return;
        }
        runtime = createApplicationCloudStartupRuntime(activeDependencies);
        runtime.subscribe(publish);
        // Runtime starts publish synchronously, keeping each delete/start handoff observable.
        for (const [sessionKey, input] of preRuntimeEntries) {
          preRuntimeEntries.delete(sessionKey);
          runtime.start(input);
        }
      },
      (error: unknown) => {
        runtimeLoad = undefined;
        runtimeError = formatUiError(error);
        publish();
      },
    ));

  const start = (input: CloudStartupInput) => {
    if (!activeDependencies || runtime) {
      return runtime?.start(input);
    }
    const sessionKey = input.recovery.sessionKey;
    runtimeError = undefined;
    preRuntimeEntries.delete(sessionKey);
    preRuntimeEntries.set(sessionKey, input);
    // Each start adds at most one entry, so one oldest-entry deletion maintains the bound.
    if (preRuntimeEntries.size > 32) {
      preRuntimeEntries.delete(preRuntimeEntries.keys().next().value!);
    }
    publish();
    void ensureRuntime();
  };

  return {
    get(sessionKey) {
      if (runtime) {
        return runtime.get(sessionKey);
      }
      const input = preRuntimeEntries.get(sessionKey);
      return input
        ? {
            sessionKey,
            phase: runtimeError ? "failed" : "pending",
            startedAt: input.createdAt,
            error: runtimeError,
            retryable: Boolean(runtimeError),
          }
        : null;
    },
    start,
    retry(sessionKey) {
      const input = preRuntimeEntries.get(sessionKey);
      if (input) {
        return start(input);
      }
      runtime?.retry(sessionKey);
    },
    resumeRecovery() {
      // Ready-connection prewarm resumes durable recovery and removes first-Start chunk latency.
      void ensureRuntime();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      activeDependencies = null;
      runtime?.dispose();
      runtime = undefined;
      preRuntimeEntries.clear();
      listeners.clear();
    },
  };
}
