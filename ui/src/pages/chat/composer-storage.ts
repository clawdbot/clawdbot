import {
  observeDraftRevision,
  rememberDraftRevision,
} from "../../lib/chat/outbox-store-draft-state.ts";
import type { ComposerStorageTarget } from "../../lib/chat/outbox-store.ts";
import {
  readStoredOutboxStore,
  writeStoredOutboxStore as writeComposerStore,
  type StoredComposerState,
} from "./composer-outbox-store.ts";

export { writeStoredOutboxStore as writeComposerStore } from "./composer-outbox-store.ts";

export function readComposerStore(
  storage: Storage,
  target: ComposerStorageTarget,
): StoredComposerState {
  const hasCurrentStore = storage.getItem(target.key) !== null;
  const hasLegacyStore =
    !hasCurrentStore &&
    target.legacyOwnerIsUnambiguous &&
    storage.getItem(target.legacyKey) !== null;
  const store = readStoredOutboxStore(storage, target);
  for (const [sessionKey, session] of Object.entries(store.sessions)) {
    observeDraftRevision(session.draftRevision);
    rememberDraftRevision(storage, target.key, sessionKey, session.draftRevision);
  }
  if (hasLegacyStore) {
    try {
      writeComposerStore(storage, target, store);
      storage.removeItem(target.legacyKey);
    } catch {
      // Keep the readable v1 row when quota or privacy mode blocks migration.
    }
  }
  return store;
}
