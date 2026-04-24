import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import type { AuthProfileStore } from "./types.js";

export function dedupeProfileIds(profileIds: string[]): string[] {
  return [...new Set(profileIds)];
}

export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = resolveProviderIdForAuth(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey)
    .map(([id]) => id);
}
