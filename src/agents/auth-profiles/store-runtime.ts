// Native projection; unbound scope and snapshot operations stay in store.ts.
import { nativePluginBindings } from "../../plugins/loader-runtime-load.js";
export const {
  updateAuthProfileStoreWithLock,
  loadAuthProfileStore,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  ensureAuthProfileStoreForLocalUpdate,
  saveAuthProfileStore,
  saveAuthProfileStoreWithPreparedOwner,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} = nativePluginBindings.authStore;
