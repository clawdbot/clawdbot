import { getSafeSessionStorage } from "../../local-storage.ts";
import { normalizeStoredSession } from "./outbox-store-codec.ts";
import {
  nextDraftRevision,
  rememberedDraftAttempt,
  rememberedDraftRevision,
  rememberDraftAttempt,
  rememberDraftRevision,
} from "./outbox-store-draft-state.ts";
import {
  storageTargetForGateway,
  resolveComposerStorageScope,
  resolveStoredComposerSession,
  writeStoredOutboxStore,
  readStoredOutboxStore,
  notifyStoredChatOutboxChanges,
  type ChatComposerScope,
  type StoredChatOutboxScope,
} from "./outbox-store.ts";
type StoredComposerRetirementTarget = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

type StoredComposerRetirement = {
  scope: StoredChatOutboxScope;
  minimumRevision: number;
  retireBeforeRevision: number;
};

export function retireStoredComposerDrafts(
  state: ChatComposerScope,
  targets: readonly StoredComposerRetirementTarget[],
) {
  const storageTarget = storageTargetForGateway(state.settings?.gatewayUrl);
  if (targets.length === 0) {
    return { gatewayOwner: storageTarget.gatewayOwner, retirements: [], storageFailed: false };
  }
  const storage = getSafeSessionStorage();
  if (!storage) {
    return {
      gatewayOwner: storageTarget.gatewayOwner,
      retirements: targets.flatMap((target) => {
        if (!target.key.trim()) {
          return [];
        }
        const resolved = resolveComposerStorageScope(state, target.key, target.agentId);
        return [
          {
            scope: {
              sessionKey: resolved.conversationKey,
              ...(resolved.routingAgentId ? { agentId: resolved.routingAgentId } : {}),
            },
            minimumRevision: target.retireBeforeRevision,
            retireBeforeRevision: target.retireBeforeRevision,
          },
        ];
      }),
      storageFailed: true,
    };
  }

  const retirements: StoredComposerRetirement[] = [];
  const written: Array<{ storeSessionKey: string; revision: number }> = [];
  let visibleChanged = false;
  try {
    const store = readStoredOutboxStore(storage, storageTarget);
    let changed = false;
    for (const target of targets) {
      if (!target.key.trim()) {
        return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: true };
      }
      const resolved = resolveComposerStorageScope(
        state,
        target.key,
        target.agentId,
        store.mainAlias,
      );
      const scope: StoredChatOutboxScope = {
        sessionKey: resolved.conversationKey,
        ...(resolved.routingAgentId ? { agentId: resolved.routingAgentId } : {}),
      };
      const resolvedSession = resolveStoredComposerSession(
        store,
        state,
        scope.sessionKey,
        scope.agentId,
      );
      changed ||= resolvedSession.migrated;
      const storedRevision = resolvedSession.session?.draftRevision ?? 0;
      const currentRevision = Math.max(
        storedRevision,
        rememberedDraftRevision(storage, storageTarget.key, resolvedSession.storeSessionKey),
        rememberedDraftAttempt(storage, storageTarget.key, resolvedSession.storeSessionKey),
      );
      let minimumRevision = target.retireBeforeRevision;
      if (storedRevision < target.retireBeforeRevision) {
        minimumRevision = nextDraftRevision(Math.max(currentRevision, target.retireBeforeRevision));
        rememberDraftAttempt(
          storage,
          storageTarget.key,
          resolvedSession.storeSessionKey,
          minimumRevision,
        );
        visibleChanged ||=
          Boolean(resolvedSession.session?.draft) ||
          Boolean(resolvedSession.session?.queue?.length);
        store.sessions[resolvedSession.storeSessionKey] = {
          draftRevision: minimumRevision,
          updatedAt: Date.now(),
        };
        written.push({
          storeSessionKey: resolvedSession.storeSessionKey,
          revision: minimumRevision,
        });
        changed = true;
      }
      retirements.push({
        scope,
        minimumRevision,
        retireBeforeRevision: target.retireBeforeRevision,
      });
    }
    if (!changed) {
      return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: false };
    }
    writeStoredOutboxStore(storage, storageTarget, store);
    const persisted = readStoredOutboxStore(storage, storageTarget);
    for (const { storeSessionKey, revision } of written) {
      const session = normalizeStoredSession(persisted.sessions[storeSessionKey]);
      if (
        session?.draftRevision !== revision ||
        Boolean(session.draft) ||
        Boolean(session.queue?.length)
      ) {
        return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: true };
      }
      rememberDraftRevision(storage, storageTarget.key, storeSessionKey, revision);
    }
    if (visibleChanged) {
      notifyStoredChatOutboxChanges();
    }
    return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: false };
  } catch {
    return { gatewayOwner: storageTarget.gatewayOwner, retirements, storageFailed: true };
  }
}
