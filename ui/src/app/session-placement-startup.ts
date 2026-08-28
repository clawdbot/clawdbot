import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import type { SessionPlacementRecovery } from "../lib/sessions/session-placement-recovery.ts";
import type { ApplicationGateway } from "./gateway.ts";
import type { ApplicationInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";

export type ApplicationPlacementStartupStatus = {
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
  readonly initialTurn?: ChatQueueItem;
  readonly action?: "retry" | "check-delivery";
};

type PlacementStartupInput = {
  readonly recovery: SessionPlacementRecovery;
  readonly persistRecovery: boolean;
  readonly recovering: boolean;
  readonly createdAt: number;
};

export type ApplicationPlacementStartupDependencies = {
  gateway: ApplicationGateway;
  sessions: SessionCapability;
  initialUserMessage: ApplicationInitialUserMessageHandoff;
};

export type ApplicationPlacementStartupRuntime = {
  get: (sessionKey: string) => ApplicationPlacementStartupStatus | null;
  start: (input: PlacementStartupInput) => void;
  retry: (sessionKey: string) => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

export type ApplicationPlacementStartup = Omit<ApplicationPlacementStartupRuntime, "start"> & {
  start: (input: PlacementStartupInput) => void;
  resumeRecovery: () => void;
};

type PlacementStartupRuntimeModule = typeof import("./session-placement-startup.runtime.ts");
type PlacementStartupRuntimeLoader = () => Promise<PlacementStartupRuntimeModule>;

export function createApplicationPlacementStartup(
  dependencies: ApplicationPlacementStartupDependencies,
  loadRuntime: PlacementStartupRuntimeLoader = () =>
    import("./session-placement-startup.runtime.ts"),
): ApplicationPlacementStartup {
  const preRuntimeEntries = new Map<string, PlacementStartupInput>();
  let activeDependencies: ApplicationPlacementStartupDependencies | null = dependencies;
  let runtime: ApplicationPlacementStartupRuntime | undefined;
  let runtimeLoad: Promise<void> | undefined;
  let runtimeError: string | undefined;
  const listeners = new Set<() => void>();

  const publish = () => listeners.forEach((listener) => listener());

  const ensureRuntime = (): Promise<void> =>
    (runtimeLoad ??= loadRuntime().then(
      ({ default: createApplicationPlacementStartupRuntime }) => {
        if (!activeDependencies) {
          return;
        }
        runtime = createApplicationPlacementStartupRuntime(activeDependencies);
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

  const start = (input: PlacementStartupInput) => {
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
      const gateway = activeDependencies?.gateway;
      const client = gateway?.snapshot.client;
      return input &&
        client?.recoveryScopeReady &&
        gateway?.connection.gatewayUrl === input.recovery.gatewayUrl &&
        client.recoveryScope === input.recovery.recoveryScope
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
