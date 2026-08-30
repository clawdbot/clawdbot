import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  listSessionPlacementRecoveryStorageKeys,
  sessionPlacementRecoveryExactStorageKey,
} from "../lib/sessions/session-placement-recovery-storage-key.ts";
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
  hasPendingTurn: (sessionKey: string) => boolean;
  resumeRecovery: () => void;
  start: (input: PlacementStartupInput) => void;
  retry: (sessionKey: string) => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

export type ApplicationPlacementStartup = ApplicationPlacementStartupRuntime;

// A transport loss retains ownership, not permission to display content or execute.
export function capturePlacementStartupConnection(
  gateway: ApplicationGateway,
  { gatewayUrl, recoveryScope }: Pick<SessionPlacementRecovery, "gatewayUrl" | "recoveryScope">,
): () => boolean {
  const revision = gateway.connectionRevision;
  return () => {
    const client = gateway.snapshot.client;
    return (
      gateway.connectionRevision === revision &&
      gateway.connection.gatewayUrl === gatewayUrl &&
      (!client?.recoveryScopeReady || client.recoveryScope === recoveryScope)
    );
  };
}

type PlacementStartupRuntimeModule = typeof import("./session-placement-startup.runtime.ts");
type PlacementStartupRuntimeLoader = () => Promise<PlacementStartupRuntimeModule>;

export function createApplicationPlacementStartup(
  dependencies: ApplicationPlacementStartupDependencies,
  loadRuntime: PlacementStartupRuntimeLoader = () =>
    import("./session-placement-startup.runtime.ts"),
): ApplicationPlacementStartup {
  const preRuntimeEntries = new Map<string, () => PlacementStartupInput | undefined>();
  const { gateway } = dependencies;
  let disposed = false;
  let runtime: ApplicationPlacementStartupRuntime | undefined;
  let runtimeLoad: Promise<void> | undefined;
  let runtimeError: string | undefined;
  const listeners = new Set<() => void>();
  let stopGateway: (() => void) | undefined;
  let pendingStoredRecovery: ((sessionKey: string) => boolean) | undefined;

  const publish = () => listeners.forEach((listener) => listener());
  const readyClient = () => {
    const { client, phase } = gateway.snapshot;
    return phase === "connected" && client?.recoveryScopeReady ? client : null;
  };

  const resumeRecovery = (input?: PlacementStartupInput) => {
    if (disposed) {
      return;
    }
    stopGateway ??= gateway.subscribe(() => resumeRecovery());
    if (input) {
      if (runtime) {
        runtime.start(input);
        return;
      }
      const sessionKey = input.recovery.sessionKey;
      runtimeError = undefined;
      preRuntimeEntries.delete(sessionKey);
      const current = capturePlacementStartupConnection(gateway, input.recovery);
      preRuntimeEntries.set(sessionKey, () => (current() ? input : undefined));
      // Each start adds at most one entry, so one oldest-entry deletion maintains the bound.
      if (preRuntimeEntries.size > 32) {
        preRuntimeEntries.delete(preRuntimeEntries.keys().next().value!);
      }
      publish();
    }
    const client = readyClient();
    if (runtime) {
      if (client) {
        // An explicit Start may never have dispatched; hand it off before reconciliation.
        for (const [sessionKey, readInput] of preRuntimeEntries) {
          const pending = readInput();
          preRuntimeEntries.delete(sessionKey);
          if (pending) {
            runtime.start(pending);
          }
        }
      }
      runtime?.resumeRecovery();
      if (client && pendingStoredRecovery) {
        pendingStoredRecovery = undefined;
        publish();
      }
      return;
    }
    if (client && !input) {
      // Keys hold admission until runtime validation, even if import finishes offline.
      // They carry neither payload content nor execution permission.
      const owner = {
        gatewayUrl: gateway.connection.gatewayUrl,
        recoveryScope: client.recoveryScope,
      };
      const current = capturePlacementStartupConnection(gateway, owner);
      const keys = listSessionPlacementRecoveryStorageKeys(owner.gatewayUrl, owner.recoveryScope);
      pendingStoredRecovery = (key) =>
        current() &&
        keys.includes(
          sessionPlacementRecoveryExactStorageKey(owner.gatewayUrl, owner.recoveryScope, key),
        );
    }
    runtimeLoad ??= loadRuntime().then(
      ({ default: createApplicationPlacementStartupRuntime }) => {
        if (disposed) {
          return;
        }
        runtime = createApplicationPlacementStartupRuntime(dependencies);
        runtime.subscribe(publish);
        resumeRecovery();
      },
      (error: unknown) => {
        runtimeLoad = undefined;
        runtimeError = formatUiError(error);
        publish();
      },
    );
  };

  return {
    get(sessionKey) {
      const input = preRuntimeEntries.get(sessionKey)?.();
      if (!input) {
        return runtime?.get(sessionKey) ?? null;
      }
      return readyClient()
        ? {
            sessionKey,
            phase: runtimeError ? "failed" : "pending",
            startedAt: input.createdAt,
            error: runtimeError,
            retryable: Boolean(runtimeError),
          }
        : null;
    },
    hasPendingTurn(sessionKey) {
      return Boolean(
        preRuntimeEntries.get(sessionKey)?.() ||
        runtime?.hasPendingTurn(sessionKey) ||
        pendingStoredRecovery?.(sessionKey),
      );
    },
    start: resumeRecovery,
    retry(sessionKey) {
      const input = preRuntimeEntries.get(sessionKey)?.();
      if (input) {
        return resumeRecovery(input);
      }
      runtime?.retry(sessionKey);
    },
    resumeRecovery,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      stopGateway?.();
      disposed = true;
      runtime?.dispose();
      runtime = undefined;
      preRuntimeEntries.clear();
      pendingStoredRecovery = undefined;
      listeners.clear();
    },
  };
}
