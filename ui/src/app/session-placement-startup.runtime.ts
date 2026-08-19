import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  createGatewayConnectionLifecycle,
  type GatewayConnectionScope,
} from "../lib/gateway-connection-lifecycle.ts";
import { hasVideoMediaFileExtension } from "../lib/media-file-extension.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import {
  clearSessionPlacementRecovery,
  listSessionPlacementRecoveries,
  readSessionPlacementRecovery,
  type SessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import {
  advanceSessionPlacementDraft,
  type SessionPlacementDraftAdvanceResult,
} from "../lib/sessions/session-placement-submit.ts";
import type { ApplicationInitialUserMessage } from "./initial-user-message-handoff.ts";
import type {
  ApplicationPlacementStartupRuntime,
  ApplicationPlacementStartupDependencies,
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
  recovery: SessionPlacementRecovery | null;
  readonly owner: PlacementStartupOwner;
  persistRecovery: boolean;
  readonly createdAt: number;
  readonly scope: GatewayConnectionScope;
  state: "pending" | "sending" | "failed";
  error?: string;
  retryable?: boolean;
};

type DurableAttachment = {
  content: string;
  fileName?: string;
  mimeType: string;
};

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const BASE64_CONTENT = /^[A-Za-z0-9+/]+={0,2}$/;

function readDurableAttachment(value: unknown): DurableAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value;
  const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!MIME_TYPE.test(mimeType) || !BASE64_CONTENT.test(content)) {
    return null;
  }
  return {
    content,
    mimeType,
    ...(typeof record.fileName === "string" ? { fileName: record.fileName } : {}),
  };
}

function buildInitialUserMessage(
  recovery: SessionPlacementRecovery,
  createdAt: number,
  identity: { messageId: string; messageSeq?: number },
): ApplicationInitialUserMessage {
  const content: ApplicationInitialUserMessage["content"] = [];
  const text = recovery.message.trim();
  if (text) {
    content.push({ type: "text", text });
  }
  for (const value of recovery.attachments ?? []) {
    const attachment = readDurableAttachment(value);
    if (!attachment) {
      continue;
    }
    const url = `data:${attachment.mimeType};base64,${attachment.content}`;
    if (attachment.mimeType.startsWith("image/")) {
      content.push({ type: "image", url, source: { type: "url", url } });
      continue;
    }
    const normalizedMimeType = attachment.mimeType.toLowerCase();
    const video =
      normalizedMimeType.startsWith("video/") ||
      ((normalizedMimeType === "" || normalizedMimeType === "application/octet-stream") &&
        hasVideoMediaFileExtension(attachment.fileName ?? ""));
    content.push({
      type: "attachment",
      attachment: {
        url,
        kind: normalizedMimeType.startsWith("audio/") ? "audio" : video ? "video" : "document",
        label: attachment.fileName?.trim() || "Attached file",
        mimeType: attachment.mimeType,
      },
    });
  }
  return {
    role: "user",
    content,
    timestamp: createdAt,
    __openclaw: {
      idempotencyKey: `${identity.messageId}:user`,
      ...(identity.messageSeq !== undefined ? { seq: identity.messageSeq } : {}),
    },
  };
}

export default function createApplicationPlacementStartupRuntime(
  params: ApplicationPlacementStartupDependencies,
): ApplicationPlacementStartupRuntime {
  const listeners = new Set<() => void>();
  const entries = new Map<string, PlacementStartupEntry>();
  const connection = createGatewayConnectionLifecycle(params.gateway.snapshot);
  let lastRecoveryClient: object | null = null;
  const recoveredFingerprints = new Set<string>();
  let disposed = false;

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
      connection.isCurrent(entry.scope) &&
      snapshot.client?.recoveryScopeReady &&
      params.gateway.connection.gatewayUrl === entry.owner.gatewayUrl &&
      snapshot.client.recoveryScope === entry.owner.recoveryScope,
    );
  };

  const setEntryState = (
    entry: PlacementStartupEntry,
    state: PlacementStartupEntry["state"],
    details: { error?: string; retryable?: boolean } = {},
  ) => {
    if (!ownsEntry(entry)) {
      return;
    }
    if (
      entry.state === state &&
      entry.error === details.error &&
      entry.retryable === details.retryable
    ) {
      return;
    }
    entry.state = state;
    entry.error = details.error;
    entry.retryable = details.retryable;
    publish();
  };

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
    params.initialUserMessage.prepare({
      sessionKey: entry.owner.sessionKey,
      owner: entry.scope.client,
      pendingRunId: result.messageId,
      message: buildInitialUserMessage(recovery, entry.createdAt, result),
    });
  };

  const refreshAfterFailure = (entry: PlacementStartupEntry) => {
    if (!lifecycleCurrent(entry)) {
      return;
    }
    void params.sessions.refresh({ force: true, backgroundHydrate: true }).catch(() => undefined);
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
      cleanupOnCancellation: !entry.persistRecovery,
      recovering,
      isLifecycleCurrent: () => lifecycleCurrent(entry),
      ownsRecovery: () => ownsEntry(entry),
      clearRecovery: () =>
        clearSessionPlacementRecovery(
          entry.owner.gatewayUrl,
          entry.owner.recoveryScope,
          entry.owner.sessionKey,
        ),
      setRecoveryPhase: (phase, durable) => {
        if (phase !== "sending") {
          return;
        }
        const sendingRecovery = { ...currentRecovery, phase };
        entry.recovery = sendingRecovery;
        entry.persistRecovery = durable;
        currentRecovery = sendingRecovery;
        setEntryState(entry, "sending");
      },
    })
      .then((result) => {
        if (findEntry(entry.owner.sessionKey)?.entry !== entry) {
          return;
        }
        if (result.status === "started") {
          accepted = true;
          prepareAcceptedMessage(entry, currentRecovery, result);
          retireEntry(entry);
          return;
        }
        if (result.status === "send-rejected" || result.status === "cleanup-rejected") {
          setEntryState(entry, "failed", { error: result.error, retryable: true });
          if (entry.persistRecovery) {
            entry.recovery = null;
          }
          return;
        }
        if (result.status === "dispatch-rejected") {
          entry.recovery = null;
          setEntryState(entry, "failed", { error: result.error, retryable: false });
          return;
        }
        if (result.status === "cancelled" && result.cleanupError) {
          setEntryState(entry, "failed", {
            error: result.cleanupError,
            retryable: result.recoveryPersisted,
          });
          if (entry.persistRecovery) {
            entry.recovery = null;
          }
          return;
        }
        retireEntry(entry);
      })
      .catch((error: unknown) => {
        if (findEntry(entry.owner.sessionKey)?.entry === entry) {
          setEntryState(entry, "failed", { error: formatUiError(error), retryable: true });
          if (entry.persistRecovery) {
            entry.recovery = null;
          }
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
    const existing = findEntry(input.recovery.sessionKey)?.entry;
    if (
      (existing?.state === "pending" || existing?.state === "sending") &&
      lifecycleCurrent(existing)
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
      recovery: input.recovery,
      owner,
      persistRecovery: input.persistRecovery,
      createdAt: input.createdAt,
      scope,
      state: "pending",
    };
    entries.set(owner.sessionKey, entry);
    publish();
    run(entry, input.recovery, input.recovering);
  };

  const handleGatewaySnapshot = (
    snapshot: ApplicationPlacementStartupDependencies["gateway"]["snapshot"],
  ) => {
    connection.transition(snapshot);
    if (snapshot.phase !== "connected") {
      lastRecoveryClient = null;
      recoveredFingerprints.clear();
      return;
    }
    if (!snapshot.client?.recoveryScopeReady || !snapshot.client.recoveryScope) {
      return;
    }
    const recoveries = listSessionPlacementRecoveries(
      params.gateway.connection.gatewayUrl,
      snapshot.client.recoveryScope,
    ).filter((recovery) => recovery.phase !== "creating");
    if (lastRecoveryClient !== snapshot.client) {
      lastRecoveryClient = snapshot.client;
      recoveredFingerprints.clear();
    }
    const currentFingerprints = new Set<string>();
    for (const recovery of recoveries) {
      const fingerprint = `${recovery.sessionKey}\0${recovery.messageId}\0${recovery.phase}`;
      currentFingerprints.add(fingerprint);
      if (recoveredFingerprints.has(fingerprint)) {
        continue;
      }
      recoveredFingerprints.add(fingerprint);
      start({ recovery, persistRecovery: true, recovering: true, createdAt: Date.now() });
    }
    for (const fingerprint of recoveredFingerprints) {
      if (!currentFingerprints.has(fingerprint)) {
        recoveredFingerprints.delete(fingerprint);
      }
    }
  };
  const stopGateway = params.gateway.subscribe(handleGatewaySnapshot);
  // Let the facade drain queued fresh Starts before durable recovery claims the same session.
  queueMicrotask(() => {
    if (!disposed) {
      handleGatewaySnapshot(params.gateway.snapshot);
    }
  });

  return {
    get(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry) {
        return null;
      }
      let phase: PlacementStartupPhase = entry.state;
      if (entry.state === "pending") {
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
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.retryable !== undefined ? { retryable: entry.retryable } : {}),
      };
    },
    start,
    retry(sessionKey) {
      const entry = findEntry(sessionKey)?.entry;
      if (!entry?.retryable || !lifecycleCurrent(entry)) {
        return;
      }
      const recovery = entry.persistRecovery
        ? readSessionPlacementRecovery(
            entry.owner.gatewayUrl,
            entry.owner.recoveryScope,
            entry.owner.sessionKey,
          )
        : entry.recovery;
      if (
        !recovery ||
        !areUiSessionKeysEquivalent(recovery.sessionKey, entry.owner.sessionKey) ||
        recovery.messageId !== entry.owner.messageId
      ) {
        return;
      }
      start({
        recovery,
        persistRecovery: entry.persistRecovery,
        recovering: true,
        createdAt: entry.createdAt,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      connection.dispose();
      stopGateway();
      entries.clear();
      listeners.clear();
    },
  };
}
