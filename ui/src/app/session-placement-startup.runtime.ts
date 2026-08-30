import type { GatewaySessionRow } from "../api/types.ts";
import type { ChatAttachment, ChatQueueItem } from "../lib/chat/chat-types.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionScope,
} from "../lib/gateway-connection-lifecycle.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import {
  clearSessionPlacementRecovery,
  listSessionPlacementRecoveries,
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
  type SessionPlacementPendingRecovery,
  type SessionPlacementPausedRecovery,
  pauseSessionPlacementRecovery,
  writeSessionPlacementRecoveryIfAvailable,
} from "../lib/sessions/session-placement-recovery.ts";
import {
  advanceSessionPlacementDraft,
  type SessionPlacementDraftAdvanceResult,
} from "../lib/sessions/session-placement-submit.ts";
import { generateUUID } from "../lib/uuid.ts";
import { restoreChatApiAttachments } from "../pages/chat/attachment-api.ts";
import { buildLocalUserMessage } from "../pages/chat/user-message-content.ts";
import {
  capturePlacementStartupConnection,
  type ApplicationPlacementStartupRuntime,
  type ApplicationPlacementStartupDependencies,
} from "./session-placement-startup.ts";

type PlacementStartupPhase = NonNullable<
  ReturnType<ApplicationPlacementStartupRuntime["get"]>
>["phase"];
type StartupPlacementPhase = Exclude<PlacementStartupPhase, "pending" | "sending" | "failed">;

const STARTUP_PLACEMENT_STATES: ReadonlySet<string> = new Set<StartupPlacementPhase>([
  "requested",
  "provisioning",
  "syncing",
  "starting",
  "active",
]);

function isStartupPlacementPhase(value: string): value is StartupPlacementPhase {
  return STARTUP_PLACEMENT_STATES.has(value);
}

type PlacementStartupInput = Parameters<ApplicationPlacementStartupRuntime["start"]>[0];

type PlacementStartupOwner = Pick<
  SessionPlacementRecovery,
  "gatewayUrl" | "messageId" | "recoveryScope" | "sessionKey"
>;

type PlacementStartupEntry = {
  work:
    | { kind: "running"; recovery: SessionPlacementPendingRecovery }
    | { kind: "checking"; recovery: SessionPlacementRecovery }
    | { kind: "paused"; recovery: SessionPlacementPausedRecovery };
  readonly owner: PlacementStartupOwner;
  readonly attachments: ChatAttachment[];
  readonly persistRecovery: boolean;
  readonly createdAt: number;
  readonly scope: GatewayConnectionScope;
  readonly retainsConnection: () => boolean;
};

function initialTurn(entry: PlacementStartupEntry): ChatQueueItem {
  const recovery = entry.work.recovery;
  return {
    id: recovery.messageId,
    text: recovery.message,
    attachments: entry.attachments,
    createdAt: entry.createdAt,
    sessionKey: recovery.sessionKey,
    agentId: recovery.agentId,
    sendRunId: recovery.messageId,
    sendAttempts: 1,
    sendState:
      entry.work.kind === "checking"
        ? "unconfirmed"
        : recovery.phase === "paused"
          ? recovery.reason === "unconfirmed"
            ? "unconfirmed"
            : "failed"
          : "sending",
    ...(recovery.phase === "paused" ? { sendError: recovery.error } : {}),
  };
}

export default function createApplicationPlacementStartupRuntime(
  params: ApplicationPlacementStartupDependencies,
): ApplicationPlacementStartupRuntime {
  const listeners = new Set<() => void>();
  const entries = new Map<string, PlacementStartupEntry>();
  const connection = createGatewayConnectionLifecycle(params.gateway.snapshot);

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const findEntry = (sessionKey: string) => {
    for (const [key, entry] of entries) {
      if (areUiSessionKeysEquivalent(key, sessionKey)) {
        return { key, entry };
      }
    }
    return null;
  };

  const ownsEntry = (entry: PlacementStartupEntry) =>
    findEntry(entry.owner.sessionKey)?.entry === entry;

  const lifecycleCurrent = (entry: PlacementStartupEntry) => {
    const snapshot = params.gateway.snapshot;
    return Boolean(
      entry.retainsConnection() &&
      connection.isCurrent(entry.scope) &&
      snapshot.client?.recoveryScopeReady,
    );
  };

  const ownsRecovery = (entry: PlacementStartupEntry) => {
    const stored = entry.persistRecovery
      ? readSessionPlacementRecovery(
          entry.owner.gatewayUrl,
          entry.owner.recoveryScope,
          entry.owner.sessionKey,
        )
      : null;
    return ownsEntry(entry) && (!stored || stored.messageId === entry.owner.messageId);
  };
  const isCurrent = (entry: PlacementStartupEntry) =>
    lifecycleCurrent(entry) && ownsRecovery(entry);

  const retireEntry = (entry: PlacementStartupEntry, notify = true) => {
    const found = findEntry(entry.owner.sessionKey);
    if (found?.entry !== entry) {
      return;
    }
    entries.delete(found.key);
    if (notify) {
      publish();
    }
  };

  const prepareAcceptedMessage = (
    entry: PlacementStartupEntry,
    recovery: SessionPlacementRecovery,
    result: Extract<SessionPlacementDraftAdvanceResult, { status: "started" }>,
  ) => {
    const message = buildLocalUserMessage({
      text: recovery.message,
      attachments: entry.attachments,
      createdAt: entry.createdAt,
      runId: result.messageId,
      sequence: result.messageSeq,
    });
    if (message) {
      params.initialUserMessage.prepare({
        sessionKey: entry.owner.sessionKey,
        owner: entry.scope.client,
        pendingRunId: result.messageId,
        message,
      });
    }
  };

  const refreshAfterFailure = (entry: PlacementStartupEntry) => {
    if (!isCurrent(entry)) {
      return;
    }
    void params.sessions.refresh({ force: true, backgroundHydrate: true }).catch(() => undefined);
  };

  const pauseEntry = (
    entry: PlacementStartupEntry,
    recovery: SessionPlacementRecovery,
    error: string,
  ) => {
    const paused = pauseSessionPlacementRecovery(recovery, error, entry.persistRecovery);
    entry.work = { kind: "paused", recovery: paused };
    publish();
  };

  const run = (
    entry: PlacementStartupEntry,
    recovery: SessionPlacementRecovery,
    recovering: boolean,
  ) => {
    let accepted = false;
    let currentRecovery = recovery;
    void advanceSessionPlacementDraft({
      client: entry.scope.client,
      recovery: currentRecovery,
      persistRecovery: entry.persistRecovery,
      cleanupOnCancellation: () => !entry.persistRecovery && entry.work.kind !== "paused",
      recovering,
      isLifecycleCurrent: () => lifecycleCurrent(entry),
      ownsRecovery: () => ownsRecovery(entry),
      clearRecovery: () =>
        clearSessionPlacementRecovery(
          entry.owner.gatewayUrl,
          entry.owner.recoveryScope,
          entry.owner.sessionKey,
          entry.owner.messageId,
        ),
      setRecoveryPhase: (phase) => {
        currentRecovery = { ...currentRecovery, phase };
        entry.work = { kind: "running", recovery: currentRecovery };
        publish();
      },
    })
      .then((result) => {
        if (!ownsRecovery(entry) || !entry.retainsConnection()) {
          retireEntry(entry);
          return;
        }
        if (result.status === "paused") {
          entry.work = { kind: "paused", recovery: result.recovery };
          publish();
          handleGatewaySnapshot(params.gateway.snapshot);
          return;
        }
        if (result.status === "cancelled" && result.cleanupError) {
          pauseEntry(entry, currentRecovery, result.cleanupError);
          handleGatewaySnapshot(params.gateway.snapshot);
          return;
        }
        if (!lifecycleCurrent(entry)) {
          // Interruption retains intent; only confirmed retirement releases admission.
          if (result.status !== "interrupted") {
            retireEntry(entry);
          }
          return;
        }
        if (result.status === "started") {
          accepted = true;
          prepareAcceptedMessage(entry, currentRecovery, result);
        }
        retireEntry(entry);
      })
      .catch((error: unknown) => {
        if (isCurrent(entry)) {
          pauseEntry(entry, currentRecovery, formatUiError(error));
        }
      })
      .finally(() => {
        if (!accepted) {
          refreshAfterFailure(entry);
        }
      });
  };

  const start = (input: PlacementStartupInput) => {
    if (input.recovery.phase === "creating") {
      return;
    }
    connection.transition(params.gateway.snapshot);
    const existing = findEntry(input.recovery.sessionKey)?.entry;
    if (
      existing &&
      isCurrent(existing) &&
      existing.owner.messageId === input.recovery.messageId &&
      (existing.work.kind !== "paused" || input.recovery.phase === "paused")
    ) {
      return;
    }
    if (existing) {
      retireEntry(existing, false);
    }
    const scope = connection.capture();
    if (!scope) {
      return;
    }
    const owner: PlacementStartupOwner = {
      sessionKey: input.recovery.sessionKey,
      messageId: input.recovery.messageId,
      gatewayUrl: input.recovery.gatewayUrl,
      recoveryScope: input.recovery.recoveryScope,
    };
    const entry: PlacementStartupEntry = {
      work:
        input.recovery.phase === "paused"
          ? { kind: "paused", recovery: input.recovery }
          : {
              kind: input.recovery.phase === "sending" ? "checking" : "running",
              recovery: input.recovery,
            },
      owner,
      // Status reads must not rescan payloads or mint new attachment identities.
      attachments: restoreChatApiAttachments(input.recovery.attachments),
      persistRecovery: input.persistRecovery,
      createdAt: input.createdAt,
      scope,
      retainsConnection: capturePlacementStartupConnection(params.gateway, owner),
    };
    entries.set(owner.sessionKey, entry);
    publish();
    if (input.recovery.phase !== "paused") {
      run(entry, input.recovery, input.recovering);
    }
  };

  const handleGatewaySnapshot = (
    snapshot: ApplicationPlacementStartupDependencies["gateway"]["snapshot"],
  ) => {
    connection.transition(snapshot);
    if (snapshot.phase !== "connected") {
      return;
    }
    if (!snapshot.client?.recoveryScopeReady || !snapshot.client.recoveryScope) {
      return;
    }
    // Paused memory-only submissions have no storage row to rehydrate. Replace
    // their lifecycle binding only after the same credential scope is validated.
    for (const entry of entries.values()) {
      if (
        entry.work.kind !== "running" &&
        !lifecycleCurrent(entry) &&
        entry.retainsConnection() &&
        ownsRecovery(entry)
      ) {
        start({
          recovery: entry.work.recovery,
          persistRecovery: entry.persistRecovery,
          recovering: true,
          createdAt: entry.createdAt,
        });
      }
    }
    for (const recovery of listSessionPlacementRecoveries(
      params.gateway.connection.gatewayUrl,
      snapshot.client.recoveryScope,
    )) {
      start({ recovery, persistRecovery: true, recovering: true, createdAt: Date.now() });
    }
  };

  return {
    resumeRecovery: () => handleGatewaySnapshot(params.gateway.snapshot),
    hasPendingTurn(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      return Boolean(entry && entry.retainsConnection() && ownsRecovery(entry));
    },
    get(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || !isCurrent(entry)) {
        return null;
      }
      let phase: PlacementStartupPhase =
        entry.work.kind !== "running"
          ? "failed"
          : entry.work.recovery.phase === "sending"
            ? "sending"
            : "pending";
      if (phase === "pending") {
        const row = params.sessions.state.result?.sessions.find((candidate: GatewaySessionRow) =>
          areUiSessionKeysEquivalent(candidate.key, entry.owner.sessionKey),
        );
        const placementState = row?.placement?.state;
        if (placementState && isStartupPlacementPhase(placementState)) {
          phase = placementState;
        }
      }
      return {
        sessionKey: entry.owner.sessionKey,
        phase,
        startedAt: entry.createdAt,
        initialTurn: initialTurn(entry),
        ...(entry.work.kind !== "running"
          ? {
              ...(entry.work.recovery.phase === "paused"
                ? { error: entry.work.recovery.error }
                : {}),
              retryable: true,
              action:
                entry.work.kind === "checking" ||
                (entry.work.recovery.phase === "paused" &&
                  entry.work.recovery.reason === "unconfirmed")
                  ? ("check-delivery" as const)
                  : ("retry" as const),
            }
          : {}),
      };
    },
    start,
    pause(sessionKey, error) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || !isCurrent(entry)) {
        return;
      }
      const recovery = pauseSessionPlacementRecovery(
        entry.work.recovery,
        error,
        entry.persistRecovery,
      );
      // Replace the owner before Stop leaves the browser; late active dispatch replies lose send authority.
      entry.work = { kind: "paused", recovery };
      retireEntry(entry, false);
      start({
        recovery,
        persistRecovery: entry.persistRecovery,
        recovering: true,
        createdAt: entry.createdAt,
      });
    },
    retry(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry || entry.work.kind !== "paused" || !isCurrent(entry)) {
        return;
      }
      if (entry.work.recovery.reason === "unconfirmed") {
        entry.work = { kind: "checking", recovery: entry.work.recovery };
        publish();
        run(entry, entry.work.recovery, true);
        return;
      }
      const { reason, error: _error, ...submission } = entry.work.recovery;
      const recovery: SessionPlacementPendingRecovery = {
        ...submission,
        phase: "dispatching",
        messageId: reason === "rejected" ? generateUUID() : submission.messageId,
      };
      // Rotate a known failed attempt atomically with its durable ownership.
      // Late completion of the old key cannot retire or replace this attempt.
      if (
        entry.persistRecovery &&
        !writeSessionPlacementRecoveryIfAvailable(recovery, submission.messageId)
      ) {
        pauseEntry(entry, entry.work.recovery, "placement recovery storage is unavailable");
        return;
      }
      start({
        recovery,
        persistRecovery: entry.persistRecovery,
        recovering: false,
        createdAt: entry.createdAt,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      connection.dispose();
      entries.clear();
      listeners.clear();
    },
  };
}
