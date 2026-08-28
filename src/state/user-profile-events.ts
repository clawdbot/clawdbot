import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const changes = resolveGlobalSingleton(Symbol.for("openclaw.userProfileChanges"), () => ({
  version: 0,
  listeners: new Set<() => void>(),
}));

export function readUserProfileVersion(): number {
  return changes.version;
}

export function onUserProfilesChanged(listener: () => void): () => void {
  changes.listeners.add(listener);
  return () => {
    changes.listeners.delete(listener);
  };
}

/** No profile data crosses this notification; readers reapply their own visibility policy. */
export function emitUserProfilesChanged(): void {
  changes.version += 1;
  for (const listener of changes.listeners) {
    try {
      listener();
    } catch {
      /* Persistence already committed. */
    }
  }
}
