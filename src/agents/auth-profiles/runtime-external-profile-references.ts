import { isDeepStrictEqual } from "node:util";
import { cloneAuthProfileStore } from "./clone.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

type RuntimeExternalCliStore = AuthProfileStore &
  Pick<RuntimeAuthProfileStore, "runtimeExternalCliProfileIds">;

export function getRuntimeExternalCliProfileIds(store: AuthProfileStore): readonly string[] {
  return (store as RuntimeExternalCliStore).runtimeExternalCliProfileIds ?? [];
}

export function setRuntimeExternalCliProfileIds(
  store: AuthProfileStore,
  profileIds: Iterable<string>,
): void {
  const ids = [...new Set(profileIds)].filter((profileId) => store.profiles[profileId]).toSorted();
  (store as RuntimeExternalCliStore).runtimeExternalCliProfileIds =
    ids.length > 0 ? ids : undefined;
}

export function removeRuntimeExternalProfileReferences(params: {
  store: AuthProfileStore;
  profileIds: ReadonlySet<string>;
}): AuthProfileStore {
  if (params.profileIds.size === 0) {
    return params.store;
  }
  const next = cloneAuthProfileStore(params.store);
  for (const profileId of params.profileIds) {
    delete next.profiles[profileId];
    if (next.usageStats) {
      delete next.usageStats[profileId];
    }
  }
  if (next.order) {
    const order = Object.fromEntries(
      Object.entries(next.order)
        .map(
          ([provider, profileIds]) =>
            [
              provider,
              profileIds.filter((profileId) => !params.profileIds.has(profileId)),
            ] as const,
        )
        .filter(([, profileIds]) => profileIds.length > 0),
    );
    next.order = Object.keys(order).length > 0 ? order : undefined;
  }
  if (next.lastGood) {
    const lastGood = Object.fromEntries(
      Object.entries(next.lastGood).filter(([, profileId]) => !params.profileIds.has(profileId)),
    );
    next.lastGood = Object.keys(lastGood).length > 0 ? lastGood : undefined;
  }
  if (next.usageStats && Object.keys(next.usageStats).length === 0) {
    next.usageStats = undefined;
  }
  next.runtimePersistedProfileIds = next.runtimePersistedProfileIds?.filter(
    (profileId) => !params.profileIds.has(profileId),
  );
  if (next.runtimePersistedProfileIds?.length === 0) {
    next.runtimePersistedProfileIds = undefined;
  }
  next.runtimeExternalProfileIds = next.runtimeExternalProfileIds?.filter(
    (profileId) => !params.profileIds.has(profileId),
  );
  if (
    next.runtimeExternalProfileIds?.length === 0 &&
    next.runtimeExternalProfileIdsAuthoritative !== true
  ) {
    next.runtimeExternalProfileIds = undefined;
  }
  setRuntimeExternalCliProfileIds(
    next,
    getRuntimeExternalCliProfileIds(next).filter((profileId) => !params.profileIds.has(profileId)),
  );
  return next;
}

/** Carries lifecycle-owned external profiles across a durable-store refresh. */
export function mergeRuntimeExternalProfileReferences(params: {
  next: AuthProfileStore;
  existing: AuthProfileStore;
}): AuthProfileStore {
  const runtimeExternalProfileIds = new Set(params.existing.runtimeExternalProfileIds ?? []);
  if (params.next.runtimeExternalProfileIdsAuthoritative === true) {
    return params.next;
  }
  if (runtimeExternalProfileIds.size === 0) {
    return params.next;
  }
  const merged = cloneAuthProfileStore(params.next);
  const mergedRuntimeExternalProfileIds = new Set(merged.runtimeExternalProfileIds ?? []);
  const mergedRuntimeExternalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(merged));
  const existingRuntimeExternalCliProfileIds = new Set(
    getRuntimeExternalCliProfileIds(params.existing),
  );
  const backfilledRuntimeExternalProfileIds = new Set<string>();
  for (const profileId of runtimeExternalProfileIds) {
    const existingCredential = params.existing.profiles[profileId];
    const nextCredential = merged.profiles[profileId];
    if (nextCredential) {
      if (
        mergedRuntimeExternalProfileIds.has(profileId) ||
        (existingCredential && isDeepStrictEqual(nextCredential, existingCredential))
      ) {
        mergedRuntimeExternalProfileIds.add(profileId);
        if (existingRuntimeExternalCliProfileIds.has(profileId)) {
          mergedRuntimeExternalCliProfileIds.add(profileId);
        }
      }
      continue;
    }
    if (!existingCredential) {
      continue;
    }
    merged.profiles[profileId] = existingCredential;
    mergedRuntimeExternalProfileIds.add(profileId);
    if (existingRuntimeExternalCliProfileIds.has(profileId)) {
      mergedRuntimeExternalCliProfileIds.add(profileId);
    }
    backfilledRuntimeExternalProfileIds.add(profileId);
    if (params.existing.usageStats?.[profileId]) {
      merged.usageStats = {
        ...merged.usageStats,
        [profileId]: params.existing.usageStats[profileId],
      };
    }
  }
  for (const [provider, profileIds] of Object.entries(params.existing.order ?? {})) {
    const externalProfileIds = profileIds.filter((profileId) =>
      backfilledRuntimeExternalProfileIds.has(profileId),
    );
    if (externalProfileIds.length === 0 || merged.order?.[provider]) {
      continue;
    }
    merged.order = {
      ...merged.order,
      [provider]: externalProfileIds,
    };
  }
  for (const [provider, profileId] of Object.entries(params.existing.lastGood ?? {})) {
    if (!backfilledRuntimeExternalProfileIds.has(profileId) || merged.lastGood?.[provider]) {
      continue;
    }
    merged.lastGood = {
      ...merged.lastGood,
      [provider]: profileId,
    };
  }
  const profileIds = [...mergedRuntimeExternalProfileIds].toSorted();
  merged.runtimeExternalProfileIds =
    profileIds.length > 0 || params.existing.runtimeExternalProfileIdsAuthoritative === true
      ? profileIds
      : undefined;
  merged.runtimeExternalProfileIdsAuthoritative =
    params.existing.runtimeExternalProfileIdsAuthoritative === true ? true : undefined;
  setRuntimeExternalCliProfileIds(merged, mergedRuntimeExternalCliProfileIds);
  return merged;
}
