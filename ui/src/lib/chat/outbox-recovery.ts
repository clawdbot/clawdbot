import { getSafeSessionStorage } from "../../local-storage.ts";
import { resolveUiConversationIdentity, hasUiSessionDefaults } from "../sessions/session-key.ts";
import {
  observeOutboxRecoveryOwner,
  outboxPayloadMatchesOwner,
} from "./outbox-payload-store.runtime.ts";
import { normalizeStoredSession } from "./outbox-store-codec.ts";
import { nextDraftRevision, readDraftRevisionState } from "./outbox-store-draft-state.ts";
import {
  notifyStoredChatOutboxChanges,
  readStoredOutboxStore,
  resolvePendingComposerSessions,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  writeStoredOutboxStore,
  type ChatComposerScope,
  type StoredChatOutboxScope,
  type StoredComposerRecovery,
} from "./outbox-store.ts";

export type ChatOutboxRecoveryEntry = StoredComposerRecovery & { id: string };
export type ChatOutboxRecoveryResult = "restored" | "conflict" | "storage-failed";

export function readChatOutboxRecovery(state: ChatComposerScope): {
  entries: ChatOutboxRecoveryEntry[];
  blocked: boolean;
} {
  const storage = getSafeSessionStorage();
  if (!storage) {
    throw new Error("Browser storage is unavailable");
  }
  const store = readStoredOutboxStore(storage, storageTargetForGateway(state.settings?.gatewayUrl));
  return {
    entries: Object.entries(store.recovery)
      .filter(([, entry]) =>
        (entry.session.queue ?? []).every((item) => outboxPayloadMatchesOwner(state, item)),
      )
      .map(([id, entry]) => Object.assign({}, entry, { id })),
    blocked: store.recoveryBlocked === true,
  };
}

export function captureChatOutboxRecoveryDestination(
  state: ChatComposerScope,
  scope: StoredChatOutboxScope,
) {
  const storage = getSafeSessionStorage();
  if (
    !storage ||
    !hasUiSessionDefaults(state) ||
    state.selectedChatSessionIncognito ||
    (state.connected && state.client && !state.client.recoveryScopeReady)
  ) {
    return null;
  }
  const target = storageTargetForGateway(state.settings?.gatewayUrl);
  const store = readStoredOutboxStore(storage, target);
  resolvePendingComposerSessions(store, state);
  const storeSessionKey = storedChatOutboxScopeKey(
    resolveUiConversationIdentity(state, scope.sessionKey, scope.agentId),
  );
  const session = store.sessions[storeSessionKey] ?? null;
  return {
    scope,
    gatewayOwner: target.gatewayOwner,
    recoveryScope: observeOutboxRecoveryOwner(state),
    session: JSON.stringify(session),
    revision: readDraftRevisionState(storage, target.key, storeSessionKey, session?.draftRevision)
      .latestAttempt,
  };
}

export function restoreChatOutboxRecovery(
  state: ChatComposerScope,
  entry: ChatOutboxRecoveryEntry,
  destination: NonNullable<ReturnType<typeof captureChatOutboxRecoveryDestination>>,
  minimumRevision = 0,
): ChatOutboxRecoveryResult {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return "storage-failed";
  }
  try {
    const current = captureChatOutboxRecoveryDestination(state, destination.scope);
    if (!current || JSON.stringify(current) !== JSON.stringify(destination)) {
      return "conflict";
    }
    const target = storageTargetForGateway(state.settings?.gatewayUrl);
    const store = readStoredOutboxStore(storage, target);
    const { id, ...expected } = entry;
    if (
      JSON.stringify(store.recovery[id]) !== JSON.stringify(expected) ||
      !(entry.session.queue ?? []).every((item) => outboxPayloadMatchesOwner(state, item))
    ) {
      return "conflict";
    }
    const scope = resolveUiConversationIdentity(
      state,
      destination.scope.sessionKey,
      destination.scope.agentId,
    );
    if (storedChatOutboxScopeKey(scope) !== storedChatOutboxScopeKey(destination.scope)) {
      return "conflict";
    }
    const key = storedChatOutboxScopeKey(scope);
    const existing = store.sessions[key];
    if (existing?.draft || existing?.goalMode || existing?.queue?.length) {
      return "conflict";
    }
    const session = entry.session;
    store.sessions[key] = {
      ...session,
      awaitingDefaults: undefined,
      // Transfer is an operator edit, and must fence every older destination writer.
      draftRevision: nextDraftRevision(
        Math.max(minimumRevision, destination.revision, session.draftRevision ?? 0),
      ),
      queue: session.queue?.map((item) =>
        Object.assign({}, item, scope, {
          sendState:
            (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed"
              ? "unconfirmed"
              : "failed",
          sendError:
            item.sendError ??
            "Recovered message. Review this destination and retry only if it did not arrive.",
        }),
      ),
    };
    delete store.recovery[id];
    writeStoredOutboxStore(storage, target, store);
    const written = readStoredOutboxStore(storage, target);
    if (
      written.recovery[id] ||
      JSON.stringify(written.sessions[key]) !==
        JSON.stringify(normalizeStoredSession(store.sessions[key]))
    ) {
      return "storage-failed";
    }
    notifyStoredChatOutboxChanges();
    return "restored";
  } catch {
    return "storage-failed";
  }
}
