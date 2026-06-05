/**
 * Runtime seam for auth-profile store loading.
 * Tests can stub this facade without importing the full auth profile store
 * implementation.
 */
import { ensureAuthProfileStore as ensureAuthProfileStoreImpl } from "./auth-profiles/store.js";

type EnsureAuthProfileStore = typeof import("./auth-profiles/store.js").ensureAuthProfileStore;

/** Ensure an auth-profile store using the production store implementation. */
export function ensureAuthProfileStore(
  ...args: Parameters<EnsureAuthProfileStore>
): ReturnType<EnsureAuthProfileStore> {
  return ensureAuthProfileStoreImpl(...args);
}
