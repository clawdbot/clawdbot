import { t } from "../i18n/index.ts";
import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  listSessionPlacementRecoveryStorageKeys,
  sessionPlacementRecoveryExactStorageKey,
} from "../lib/sessions/session-placement-recovery-storage-key.ts";
import type {
  SessionPlacementRecovery,
  SessionPlacementTarget,
} from "../lib/sessions/session-placement-recovery.ts";
import { showToast } from "../lib/toast.ts";
import type { ApplicationChatSubmissions } from "./chat-submissions.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import type { ApplicationGateway } from "./gateway.ts";
import {
  isStaleChunkImportError,
  reloadControlUiDocument,
  retryStaleChunkReloadWhenReachable,
} from "./stale-chunk-reload.ts";

export type ApplicationPlacementStartupStatus = {
  readonly sessionKey: string;
  // A restored key holds admission before the lazy runtime validates its target and payload.
  readonly targetKind?: SessionPlacementTarget["kind"];
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
  readonly discardAndReload?: () => void;
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
  chatSubmissions: ApplicationChatSubmissions;
};

type PlacementStartupRecoveryAccess = Pick<
  typeof import("../lib/sessions/session-placement-recovery.ts"),
  "readSessionPlacementRecovery" | "pauseSessionPlacementRecovery"
>;

export type ApplicationPlacementStartupRuntime = {
  get: (sessionKey: string) => ApplicationPlacementStartupStatus | null;
  hasPendingTurn: (sessionKey: string) => boolean;
  resumeRecovery: () => void;
  start: (input: PlacementStartupInput) => void;
  retry: (sessionKey: string) => void;
  pause: (sessionKey: string, error: string, recovery: PlacementStartupRecoveryAccess) => void;
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
  type PendingInput = { input: PlacementStartupInput; persisted: boolean };
  const preRuntimeEntries = new Map<string, () => PendingInput | undefined>();
  const { gateway } = dependencies;
  let disposed = false;
  let runtime: ApplicationPlacementStartupRuntime | undefined;
  let runtimeLoad: { error?: Error } | undefined;
  const listeners = new Set<() => void>();
  let stopGateway: (() => void) | undefined;
  let pendingStoredRecovery:
    | {
        current: () => boolean;
        refresh: () => void;
        read: (sessionKey: string) => { startedAt: number } | undefined;
      }
    | undefined;

  const publish = () => listeners.forEach((listener) => listener());
  const readyClient = () => {
    const { client, phase } = gateway.snapshot;
    return phase === "connected" && client?.recoveryScopeReady ? client : null;
  };
  const pendingInputs = () =>
    [...preRuntimeEntries.values()]
      .map((readInput) => readInput())
      .filter((entry) => entry !== undefined);
  const canReload = () => pendingInputs().every((entry) => entry.persisted);
  const captureDiscardAndReload = () => {
    const pending = pendingInputs();
    const first = pending[0];
    if (!first) {
      return undefined;
    }
    const loading = runtimeLoad;
    const current = capturePlacementStartupConnection(gateway, first.input.recovery);
    return () => {
      const remaining = pendingInputs();
      // A retained button cannot authorize discarding a newer start or another credential owner's input.
      if (
        disposed ||
        runtimeLoad !== loading ||
        !current() ||
        pending.length !== remaining.length ||
        pending.some((entry, index) => entry !== remaining[index])
      ) {
        return;
      }
      reloadControlUiDocument();
    };
  };
  const stopReloadGuard = registerControlUiReloadGuard(canReload, () =>
    showToast({
      message: t("newSession.placementReloadBlocked"),
      actionLabel: t("newSession.discardUnsavedAndReload"),
      onAction: captureDiscardAndReload(),
    }),
  );

  const resumeRecovery = (pending?: PendingInput, retry = false) => {
    const input = pending?.input;
    if (disposed) {
      return;
    }
    stopGateway ??= gateway.subscribe(() => resumeRecovery());
    if ((input || retry) && runtimeLoad?.error) {
      runtimeLoad = undefined;
      if (!input) {
        publish();
      }
    }
    if (input) {
      if (runtime) {
        runtime.start(input);
        return;
      }
      const sessionKey = input.recovery.sessionKey;
      preRuntimeEntries.delete(sessionKey);
      const current = capturePlacementStartupConnection(gateway, input.recovery);
      preRuntimeEntries.set(sessionKey, () => (current() ? pending : undefined));
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
          const retainedInput = readInput()?.input;
          preRuntimeEntries.delete(sessionKey);
          if (retainedInput) {
            runtime.start(retainedInput);
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
      if (!pendingStoredRecovery?.current()) {
        const owner = {
          gatewayUrl: gateway.connection.gatewayUrl,
          recoveryScope: client.recoveryScope,
        };
        const current = capturePlacementStartupConnection(gateway, owner);
        let keys: string[] = [];
        const restored = { startedAt: Date.now() };
        pendingStoredRecovery = {
          current,
          refresh: () => {
            keys = listSessionPlacementRecoveryStorageKeys(owner.gatewayUrl, owner.recoveryScope);
          },
          read: (key) =>
            current() &&
            keys.includes(
              sessionPlacementRecoveryExactStorageKey(owner.gatewayUrl, owner.recoveryScope, key),
            )
              ? restored
              : undefined,
        };
      }
      // Reset can remove a creating draft while the lazy runtime is unavailable.
      pendingStoredRecovery.refresh();
    }
    // Snapshot changes retain the attempt and its observed start time. Only an
    // explicit Start or Retry can replace a failed lazy-module load.
    if (runtimeLoad) {
      return;
    }
    const loading: { error?: Error } = {};
    runtimeLoad = loading;
    void loadRuntime().then(
      ({ default: createApplicationPlacementStartupRuntime }) => {
        if (disposed) {
          return;
        }
        runtime = createApplicationPlacementStartupRuntime(dependencies);
        runtime.subscribe(publish);
        resumeRecovery();
      },
      (error: unknown) => {
        loading.error = new Error(formatUiError(error));
        publish();
      },
    );
  };

  return {
    get(sessionKey) {
      const input = preRuntimeEntries.get(sessionKey)?.()?.input;
      const pending = input
        ? { targetKind: input.recovery.target.kind, startedAt: input.createdAt }
        : pendingStoredRecovery?.read(sessionKey);
      if (!pending) {
        return runtime?.get(sessionKey) ?? null;
      }
      const error = runtimeLoad?.error;
      const reloadBlocked = isStaleChunkImportError(error) && !canReload();
      return readyClient()
        ? {
            sessionKey,
            ...pending,
            phase: error ? "failed" : "pending",
            error: reloadBlocked ? t("newSession.placementReloadBlocked") : error?.message,
            retryable: Boolean(error) && !reloadBlocked,
            ...(reloadBlocked ? { discardAndReload: captureDiscardAndReload() } : {}),
          }
        : null;
    },
    hasPendingTurn(sessionKey) {
      return Boolean(
        preRuntimeEntries.get(sessionKey)?.() ||
        runtime?.hasPendingTurn(sessionKey) ||
        pendingStoredRecovery?.read(sessionKey),
      );
    },
    // New Session confirms its initial save before handing a persistent start to this owner.
    start: (input) => resumeRecovery({ input, persisted: input.persistRecovery }),
    pause(sessionKey, error, recoveryAccess) {
      const client = readyClient();
      if (disposed || !client) {
        return;
      }
      if (runtime) {
        runtime.pause(sessionKey, error, recoveryAccess);
        return;
      }
      const pending = preRuntimeEntries.get(sessionKey)?.()?.input;
      const recovery =
        pending?.recovery ??
        recoveryAccess.readSessionPlacementRecovery(
          gateway.connection.gatewayUrl,
          client.recoveryScope,
          sessionKey,
        );
      if (!recovery) {
        return;
      }
      // Retire executable recovery before the lazy runtime can dispatch it or a reload can restore it.
      const { recovery: paused, persisted } = recoveryAccess.pauseSessionPlacementRecovery(
        recovery,
        error,
        pending?.persistRecovery ?? true,
      );
      resumeRecovery({
        input: {
          recovery: paused,
          persistRecovery: pending?.persistRecovery ?? true,
          recovering: true,
          createdAt: pending?.createdAt ?? Date.now(),
        },
        persisted,
      });
    },
    retry(sessionKey) {
      const pending = preRuntimeEntries.get(sessionKey)?.();
      if (pending || pendingStoredRecovery?.read(sessionKey)) {
        const loading = runtimeLoad;
        const error = loading?.error;
        if (isStaleChunkImportError(error)) {
          // Explicit starts also need fresh document imports after a cached failure.
          // Capture their saved key through the same restored-recovery owner.
          resumeRecovery();
          const stored = pendingStoredRecovery;
          if (!stored?.read(sessionKey)) {
            return;
          }
          void retryStaleChunkReloadWhenReachable({
            canReload: () => {
              // Reset can retire the row while the document probe is pending.
              stored.refresh();
              return (
                !disposed &&
                runtimeLoad === loading &&
                pendingStoredRecovery === stored &&
                Boolean(stored.read(sessionKey)) &&
                canReload()
              );
            },
          });
          return;
        }
        return resumeRecovery(pending, true);
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
      stopReloadGuard();
      disposed = true;
      runtime?.dispose();
      runtime = undefined;
      preRuntimeEntries.clear();
      pendingStoredRecovery = undefined;
      listeners.clear();
    },
  };
}
