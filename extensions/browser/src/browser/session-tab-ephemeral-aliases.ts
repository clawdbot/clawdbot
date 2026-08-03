/**
 * Process-local aliases for durable storage keys and non-durable tab rows.
 */
type AliasIdentity = {
  sessionKey: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
};

type VolatileAliasTarget = {
  sessionKey: string;
  tabKey: string;
};

const durableAliasStateSymbol = Symbol.for(
  "openclaw.browser.session-tabs.interaction-storage-keys",
);
const durableExactStateSymbol = Symbol.for(
  "openclaw.browser.session-tabs.exact-interaction-storage-keys",
);
const volatileAliasStateSymbol = Symbol.for("openclaw.browser.session-tabs.volatile-aliases");
const volatileExactStateSymbol = Symbol.for("openclaw.browser.session-tabs.exact-volatile-aliases");

function interactionKey(identity: AliasIdentity): string {
  return `${identity.sessionKey}\u0000${identity.baseUrl ?? ""}\u0000${identity.profile ?? ""}\u0000${identity.targetId}`;
}

function normalizedTargetIds(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
): Set<string> {
  return new Set([
    identity.targetId,
    ...aliases.flatMap((alias) => {
      const targetId = alias?.trim();
      return targetId ? [targetId] : [];
    }),
  ]);
}

function normalizedProfiles(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
): Set<string | undefined> {
  const profiles = new Set<string | undefined>([identity.profile]);
  for (const alias of aliases) {
    const profile = alias?.trim();
    if (profile) {
      profiles.add(profile);
    }
  }
  return profiles;
}

function durableKeysByInteraction(): Map<string, Set<string>> {
  const state = globalThis as typeof globalThis & {
    [durableAliasStateSymbol]?: Map<string, Set<string>>;
  };
  state[durableAliasStateSymbol] ??= new Map();
  return state[durableAliasStateSymbol];
}

function durableExactKeysByInteraction(): Map<string, Set<string>> {
  const state = globalThis as typeof globalThis & {
    [durableExactStateSymbol]?: Map<string, Set<string>>;
  };
  state[durableExactStateSymbol] ??= new Map();
  return state[durableExactStateSymbol];
}

function removeStorageKey(mappings: Map<string, Set<string>>, storageKey: string): void {
  for (const [key, storageKeys] of mappings) {
    storageKeys.delete(storageKey);
    if (storageKeys.size === 0) {
      mappings.delete(key);
    }
  }
}

export function resetDurableTabAliases(): void {
  durableKeysByInteraction().clear();
  durableExactKeysByInteraction().clear();
}

export function clearDurableTabAliases(storageKey: string): void {
  removeStorageKey(durableKeysByInteraction(), storageKey);
  removeStorageKey(durableExactKeysByInteraction(), storageKey);
}

export function rememberDurableTabAliases(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
  storageKey: string,
  profileAliases: Array<string | undefined> = [],
): void {
  clearDurableTabAliases(storageKey);
  const mappings = durableKeysByInteraction();
  const exactMappings = durableExactKeysByInteraction();
  for (const profile of normalizedProfiles(identity, profileAliases)) {
    const exactKey = interactionKey({ ...identity, profile });
    const exactStorageKeys = exactMappings.get(exactKey) ?? new Set<string>();
    exactStorageKeys.add(storageKey);
    exactMappings.set(exactKey, exactStorageKeys);
    for (const targetId of normalizedTargetIds(identity, aliases)) {
      const key = interactionKey({ ...identity, profile, targetId });
      const storageKeys = mappings.get(key) ?? new Set<string>();
      storageKeys.add(storageKey);
      mappings.set(key, storageKeys);
    }
  }
}

export function resolveDurableTabAlias(identity: AliasIdentity): string | undefined {
  const storageKeys = durableKeysByInteraction().get(interactionKey(identity));
  return storageKeys?.size === 1 ? storageKeys.values().next().value : undefined;
}

export function hasDurableTabAlias(identity: AliasIdentity): boolean {
  return (durableKeysByInteraction().get(interactionKey(identity))?.size ?? 0) > 0;
}

export function resolveDurableTabExact(identity: AliasIdentity): string | undefined {
  const storageKeys = durableExactKeysByInteraction().get(interactionKey(identity));
  return storageKeys?.size === 1 ? storageKeys.values().next().value : undefined;
}

export function hasDurableTabExact(identity: AliasIdentity): boolean {
  return (durableExactKeysByInteraction().get(interactionKey(identity))?.size ?? 0) > 0;
}

function volatileAliasTargetKey(target: VolatileAliasTarget): string {
  return JSON.stringify([target.sessionKey, target.tabKey]);
}

function volatileAliasesByInteraction(): Map<string, Map<string, VolatileAliasTarget>> {
  const state = globalThis as typeof globalThis & {
    [volatileAliasStateSymbol]?: Map<string, Map<string, VolatileAliasTarget>>;
  };
  state[volatileAliasStateSymbol] ??= new Map();
  return state[volatileAliasStateSymbol];
}

function volatileExactTargetsByInteraction(): Map<string, Map<string, VolatileAliasTarget>> {
  const state = globalThis as typeof globalThis & {
    [volatileExactStateSymbol]?: Map<string, Map<string, VolatileAliasTarget>>;
  };
  state[volatileExactStateSymbol] ??= new Map();
  return state[volatileExactStateSymbol];
}

function removeVolatileTarget(
  mappings: Map<string, Map<string, VolatileAliasTarget>>,
  targetKey: string,
): void {
  for (const [key, targets] of mappings) {
    targets.delete(targetKey);
    if (targets.size === 0) {
      mappings.delete(key);
    }
  }
}

export function clearVolatileTabAliases(sessionKey: string, tabKey: string): void {
  const targetKey = volatileAliasTargetKey({ sessionKey, tabKey });
  removeVolatileTarget(volatileAliasesByInteraction(), targetKey);
  removeVolatileTarget(volatileExactTargetsByInteraction(), targetKey);
}

export function rememberVolatileTabAliases(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
  tabKey: string,
  profileAliases: Array<string | undefined> = [],
): void {
  clearVolatileTabAliases(identity.sessionKey, tabKey);
  const target = { sessionKey: identity.sessionKey, tabKey };
  const mappings = volatileAliasesByInteraction();
  const exactMappings = volatileExactTargetsByInteraction();
  for (const profile of normalizedProfiles(identity, profileAliases)) {
    const exactKey = interactionKey({ ...identity, profile });
    const exactTargets = exactMappings.get(exactKey) ?? new Map<string, VolatileAliasTarget>();
    exactTargets.set(volatileAliasTargetKey(target), target);
    exactMappings.set(exactKey, exactTargets);
    for (const targetId of normalizedTargetIds(identity, aliases)) {
      const key = interactionKey({ ...identity, profile, targetId });
      const targets = mappings.get(key) ?? new Map<string, VolatileAliasTarget>();
      targets.set(volatileAliasTargetKey(target), target);
      mappings.set(key, targets);
    }
  }
}

export function resolveVolatileTabAlias(identity: AliasIdentity): VolatileAliasTarget | undefined {
  const targets = volatileAliasesByInteraction().get(interactionKey(identity));
  return targets?.size === 1 ? targets.values().next().value : undefined;
}

export function hasVolatileTabAlias(identity: AliasIdentity): boolean {
  return (volatileAliasesByInteraction().get(interactionKey(identity))?.size ?? 0) > 0;
}

export function resolveVolatileTabExact(identity: AliasIdentity): VolatileAliasTarget | undefined {
  const targets = volatileExactTargetsByInteraction().get(interactionKey(identity));
  return targets?.size === 1 ? targets.values().next().value : undefined;
}

export function hasVolatileTabExact(identity: AliasIdentity): boolean {
  return (volatileExactTargetsByInteraction().get(interactionKey(identity))?.size ?? 0) > 0;
}

export function forgetVolatileTabAlias(identity: AliasIdentity): void {
  volatileAliasesByInteraction().delete(interactionKey(identity));
  volatileExactTargetsByInteraction().delete(interactionKey(identity));
}
