import { getSafeSessionStorage } from "../../local-storage.ts";
import {
  nextDraftRevision,
  readDraftRevisionState,
  rememberDraftAttempt,
  rememberDraftRevision,
} from "./outbox-store-draft-state.ts";
import {
  storageTargetForGateway,
  storedChatOutboxScopeKey,
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
  state: Pick<ChatComposerScope, "settings">,
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
        return [
          {
            scope: { sessionKey: target.key, agentId: target.agentId },
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
      // Deletion targets are captured identities, not new admissions under current defaults.
      const scope = { sessionKey: target.key, agentId: target.agentId };
      const storeSessionKey = storedChatOutboxScopeKey(scope);
      const session = store.sessions[storeSessionKey];
      const storedRevision = session?.draftRevision ?? 0;
      const currentRevision = readDraftRevisionState(
        storage,
        storageTarget.key,
        storeSessionKey,
        storedRevision,
      ).latestAttempt;
      let minimumRevision = target.retireBeforeRevision;
      if (storedRevision < target.retireBeforeRevision) {
        minimumRevision = nextDraftRevision(Math.max(currentRevision, target.retireBeforeRevision));
        rememberDraftAttempt(storage, storageTarget.key, storeSessionKey, minimumRevision);
        visibleChanged ||= Boolean(session?.draft) || Boolean(session?.queue?.length);
        store.sessions[storeSessionKey] = {
          draftRevision: minimumRevision,
          updatedAt: Date.now(),
        };
        written.push({
          storeSessionKey,
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
      const session = persisted.sessions[storeSessionKey];
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
