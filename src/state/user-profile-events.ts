import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

const changes = resolveGlobalSingleton(Symbol.for("openclaw.userProfileChanges"), () => ({
  version: 0,
  listeners: new Set<() => void>(),
}));

export function readUserProfileVersion(): number {
  return changes.version;
}

export function onUserProfilesChanged(listener: () => void): () => void {
  return registerListener(changes.listeners, listener);
}

/** No profile data crosses this notification; readers reapply their own visibility policy. */
export function emitUserProfilesChanged(): void {
  changes.version += 1;
  notifyListeners(changes.listeners, undefined);
}
