// Server-side operator display prefs (config ui.prefs) are canonical: agents change them through
// the approval gate and other devices pick them up. The localStorage mirror gives instant boot and
// stays authoritative when this client cannot write config (viewer scope, offline). Pending local
// intent shadows server snapshots until the hash-free LWW ack; failed pushes degrade device-local.
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorWriteAccess } from "./operator-access.ts";
import {
  loadProfileAppearancePrefs,
  resetProfileAppearancePrefs,
  resolveProfileAppearanceProfileId,
  resolveProfileAppearancePrefs,
  resolveProfilePreferenceScope,
  writeProfileAppearancePrefs,
} from "./server-prefs-profile.ts";
import {
  extractServerUiPrefs,
  isAppearancePref,
  prefValuesEqual,
  resolveServerUiPrefStateFromSnapshot,
  serverPrefsLocalPatch,
  SYNCED_PREF_KEYS,
  SYNCED_PREFS,
  type ResettableServerUiPrefKey,
  type ServerUiPrefs,
  type ServerUiPrefState,
  type SyncedPrefKey,
  type SyncedPrefValue,
} from "./server-prefs-state.ts";
import {
  LAST_SEEN_KEY,
  PENDING_KEY,
  parseStoredPrefs,
  readRetainedLocalKeys,
  readStorage,
  readStoredPrefs,
  writeRetainedLocalKeys,
  writeStorage,
} from "./server-prefs-storage.ts";
import { loadSettings, patchSettings, type UiSettings } from "./settings.ts";
import type { ThemeName } from "./theme.ts";

type ServerUiPrefsWriter = Pick<RuntimeConfigCapability, "canPatch" | "runExternalMutation"> & {
  readonly state: {
    readonly client: GatewayBrowserClient | null;
    readonly connected: boolean;
    readonly configSnapshot?: { readonly config?: unknown } | null;
  };
};
type ServerUiPrefsCommit = {
  needsRefresh: boolean;
  retainedLocal?: boolean;
};
type ServerUiPrefsPushHooks = {
  afterCommit?: (commit: ServerUiPrefsCommit) => void;
  profileId?: string | null;
  canWrite?: boolean;
  profile?: Pick<ApplicationGatewaySnapshot, "selfUser" | "hello"> | null;
};
export type { ServerUiPrefProvenance, ServerUiPrefState } from "./server-prefs-state.ts";

export function resolveServerUiPrefState<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  scope = "",
  settings = loadSettings(),
  options: { canSync?: boolean | null; profileId?: string | null } = {},
): ServerUiPrefState<SyncedPrefValue<K>> {
  const effectiveScope = resolveProfilePreferenceScope(scope, options.profileId);
  const shadowPrefs =
    effectiveScope === pendingScope
      ? pendingPrefs
      : parseStoredPrefs(readStorage(PENDING_KEY, effectiveScope));
  return resolveServerUiPrefStateFromSnapshot(
    configObject,
    key,
    shadowPrefs,
    settings,
    options.canSync,
    resolveProfileAppearancePrefs(scope, options.profileId),
  );
}
/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(previous: UiSettings, next: UiSettings): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    if (requestedDeviceLocalPrefResets.delete(key)) {
      continue;
    }
    if (requestedServerUiPrefResets.delete(key)) {
      (prefs as Record<string, unknown>)[key] = null;
      continue;
    }
    const specification = SYNCED_PREFS[key];
    const previousValue = specification.local(previous);
    const nextValue = specification.local(next);
    if (prefValuesEqual(previousValue, nextValue)) {
      continue;
    }
    if (nextValue === undefined) {
      // JSON merge patch removes keys via explicit null.
      if (specification.clearable) {
        (prefs as Record<string, unknown>)[key] = null;
      }
      continue;
    }
    (prefs as Record<string, unknown>)[key] = nextValue;
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}
const CONFLICT_REDRAIN_DELAY_MS = 1_000;
const MAX_CONFLICT_REDRAINS = 5;
const requestedServerUiPrefResets = new Set<SyncedPrefKey>();
const requestedDeviceLocalPrefResets = new Set<SyncedPrefKey>();
let applyingServerPrefs = false;
let pendingScope = "";
let pendingPrefs: ServerUiPrefs | null = null;
let pendingPersistedKeys = new Set<SyncedPrefKey>();
let pushWriter: ServerUiPrefsWriter | null = null;
let pushScope = "";
let pushProfileId: string | null = null;
let pushCanWrite = false;
let pushAfterCommit: ((commit: ServerUiPrefsCommit) => void) | undefined;
let pushDraining = false;
let drainRequested = false;
let pushEpoch = 0;
let conflictRedrainTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveConflictRedrains = 0;
// A loaded config snapshot object is immutable. Re-evaluating a retained object after lastSeen
// moves would treat stale values as fresh deltas and revert acked edits, including after refresh
// failure. Only new objects are evaluated; the post-ack request-version bump makes them post-commit.
let lastReconciledScope = "";
let lastReconciledConfigObject: unknown = null;
function clearConflictRedrain(): void {
  if (conflictRedrainTimer !== null) {
    clearTimeout(conflictRedrainTimer);
    conflictRedrainTimer = null;
  }
  consecutiveConflictRedrains = 0;
}
function updateRetainedLocalKeys(
  scope: string,
  keys: readonly SyncedPrefKey[],
  retained: boolean,
): void {
  const stored = readRetainedLocalKeys(scope);
  for (const key of keys) {
    if (retained) {
      stored.add(key);
    } else {
      stored.delete(key);
    }
  }
  writeRetainedLocalKeys(scope, stored);
  if (retained && scope === lastReconciledScope) {
    lastReconciledConfigObject = null;
  }
}
function adoptPendingScope(scope: string, force = false): void {
  if (!force && scope === pendingScope) {
    return;
  }
  pendingScope = scope;
  const stored = readStoredPrefs(PENDING_KEY, scope);
  pendingPrefs = stored.prefs;
  pendingPersistedKeys = new Set(
    stored.available && stored.prefs ? (Object.keys(stored.prefs) as SyncedPrefKey[]) : [],
  );
}
function writePendingStorage(prefs: ServerUiPrefs | null): void {
  const persisted = writeStorage(PENDING_KEY, pendingScope, prefs ? JSON.stringify(prefs) : null);
  if (persisted) {
    pendingPersistedKeys = new Set(
      pendingPrefs ? (Object.keys(pendingPrefs) as SyncedPrefKey[]) : [],
    );
  } else {
    pendingPersistedKeys.clear();
  }
}
function cancelPendingKeys(scope: string, keys: readonly SyncedPrefKey[]): void {
  if (scope === pendingScope) {
    reconcilePersistedPendingPrefs();
  }
  const active = scope === pendingScope ? pendingPrefs : null;
  const remaining = {
    ...parseStoredPrefs(readStorage(PENDING_KEY, scope)),
    ...active,
  };
  for (const key of keys) {
    delete remaining[key];
  }
  const next = Object.keys(remaining).length ? remaining : null;
  if (scope === pendingScope) {
    pendingPrefs = next;
    writePendingStorage(next);
    return;
  }
  writeStorage(PENDING_KEY, scope, next ? JSON.stringify(next) : null);
}
// localStorage pending is a cross-tab merged pool per gateway. Per-key read-merge-write prevents
// one tab from clobbering sibling offline intent; its ms-scale race is accepted because storage has
// no CAS and the drain converges through server-side LWW.
function mergePendingIntoStorage(): void {
  const stored = parseStoredPrefs(readStorage(PENDING_KEY, pendingScope)) ?? {};
  const merged = { ...stored, ...pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
function settlePendingStorage(ackedBatch: ServerUiPrefs): void {
  const stored = { ...parseStoredPrefs(readStorage(PENDING_KEY, pendingScope)) };
  for (const key of Object.keys(ackedBatch) as SyncedPrefKey[]) {
    if (prefValuesEqual(stored[key], ackedBatch[key])) {
      delete stored[key];
    }
  }
  const merged = { ...stored, ...pendingPrefs };
  writePendingStorage(Object.keys(merged).length ? merged : null);
}
// Only persisted keys participate in cross-tab reconciliation. An in-memory-only key means
// localStorage was unavailable, so absence from storage cannot be interpreted as cancellation.
function reconcilePersistedPendingPrefs(): void {
  if (!pendingPrefs || pendingPersistedKeys.size === 0) {
    return;
  }
  const stored = readStoredPrefs(PENDING_KEY, pendingScope);
  if (!stored.available) {
    return;
  }
  const current = stored.prefs ?? {};
  for (const key of pendingPersistedKeys) {
    if (!Object.hasOwn(current, key)) {
      delete pendingPrefs[key];
      pendingPersistedKeys.delete(key);
      continue;
    }
    const storedValue = current[key];
    if (!prefValuesEqual(pendingPrefs[key], storedValue)) {
      (pendingPrefs as Record<string, unknown>)[key] = storedValue;
    }
  }
  if (!Object.keys(pendingPrefs).length) {
    pendingPrefs = null;
  }
}
function batchIsCurrent(batch: ServerUiPrefs): boolean {
  const current = pendingPrefs;
  return Boolean(
    current &&
    (Object.keys(batch) as SyncedPrefKey[]).every(
      (key) => Object.hasOwn(current, key) && prefValuesEqual(current[key], batch[key]),
    ),
  );
}
export function resetServerUiPrefsSync() {
  clearConflictRedrain();
  applyingServerPrefs = pushDraining = drainRequested = false;
  pendingScope = "";
  pendingPrefs = pushWriter = null;
  pendingPersistedKeys.clear();
  pushScope = "";
  pushProfileId = null;
  pushCanWrite = false;
  lastReconciledScope = "";
  lastReconciledConfigObject = null;
  resetProfileAppearancePrefs();
  requestedServerUiPrefResets.clear();
  requestedDeviceLocalPrefResets.clear();
}

export function resetServerUiPref<K extends ResettableServerUiPrefKey>(
  key: K,
  state?: ServerUiPrefState<SyncedPrefValue<K>>,
  scope = pendingScope,
): UiSettings {
  const specification = SYNCED_PREFS[key];
  const activeProfile = isAppearancePref(key) ? resolveProfileAppearanceProfileId(scope) : null;
  const effectiveScope = resolveProfilePreferenceScope(scope, activeProfile);
  const reset = specification.reset;
  if (!reset) {
    throw new Error(`Server UI preference is not resettable: ${key}`);
  }
  if (state?.provenance === "device-local") {
    const write = specification.write as
      | ((value: SyncedPrefValue<K> | undefined) => Partial<UiSettings>)
      | undefined;
    if (!write) {
      throw new Error(`Server UI preference cannot restore a retained local value: ${key}`);
    }
    cancelPendingKeys(effectiveScope, [key]);
    updateRetainedLocalKeys(effectiveScope, [key], false);
    requestedDeviceLocalPrefResets.add(key);
    return patchSettings(write(state.resetValue));
  }
  requestedServerUiPrefResets.add(key);
  // Profile-bound reset deletes the profile key and lands on the gateway value,
  // so the local settings must move to state.resetValue (that fallback), not the
  // product default the generic reset would apply.
  if (activeProfile && state) {
    // SAFETY: SYNCED_PREFS pairs each key's write() with that key's own value type.
    const write = specification.write as
      | ((value: SyncedPrefValue<K> | undefined) => Partial<UiSettings>)
      | undefined;
    if (write) {
      return patchSettings(write(state.resetValue));
    }
  }
  return patchSettings(reset(loadSettings()));
}
export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    profileId?: string | null;
    onApplied: (patch: Partial<UiSettings>) => void;
    onThemeChanged?: (theme: ThemeName | null) => void;
  },
): boolean {
  const gatewayScope = hooks.scope ?? "";
  const scope = resolveProfilePreferenceScope(gatewayScope, hooks.profileId);
  if (scope === lastReconciledScope && configObject === lastReconciledConfigObject) {
    return false;
  }
  // Last-seen state is per profile scope but the rendered settings are a
  // singleton: after an identity switch (A→B→A) an unchanged last-seen does not
  // mean the DOM shows this profile's values, so a switch between two known
  // scopes forces a full reconcile. Boot keeps the shortcut (mirror is current).
  const scopeChanged = lastReconciledScope !== "" && scope !== lastReconciledScope;
  const recordReconciledObject = () => {
    lastReconciledScope = scope;
    lastReconciledConfigObject = configObject;
  };
  const shadowPrefs =
    scope === pendingScope ? pendingPrefs : parseStoredPrefs(readStorage(PENDING_KEY, scope));
  const retainedLocalKeys = readRetainedLocalKeys(scope);
  const prefs = {
    ...extractServerUiPrefs(configObject),
    ...resolveProfileAppearancePrefs(gatewayScope, hooks.profileId),
  };
  const key = JSON.stringify(prefs);
  const lastSeenRaw = readStorage(LAST_SEEN_KEY, scope);
  if (!scopeChanged && key === lastSeenRaw) {
    if (retainedLocalKeys.size) {
      updateRetainedLocalKeys(scope, [...retainedLocalKeys], false);
    }
    recordReconciledObject();
    return false;
  }
  const lastSeen = parseStoredPrefs(lastSeenRaw) ?? {};
  const changed: ServerUiPrefs = {};
  // Apply per field: only keys whose server value changed since last seen. Reapplying unchanged
  // fields would revert unpushable local edits whenever any other server field moves.
  for (const prefKey of Object.keys(prefs) as Array<keyof ServerUiPrefs>) {
    if (
      !(shadowPrefs && prefKey in shadowPrefs) &&
      !retainedLocalKeys.has(prefKey) &&
      (scopeChanged || lastSeenRaw === null || !prefValuesEqual(prefs[prefKey], lastSeen[prefKey]))
    ) {
      (changed as Record<string, unknown>)[prefKey] = prefs[prefKey];
    }
  }
  for (const prefKey of Object.keys(lastSeen) as Array<keyof ServerUiPrefs>) {
    if (
      !(prefKey in prefs) &&
      !(shadowPrefs && prefKey in shadowPrefs) &&
      !retainedLocalKeys.has(prefKey) &&
      SYNCED_PREFS[prefKey]?.clearable
    ) {
      (changed as Record<string, unknown>)[prefKey] = null;
    }
  }
  if (scopeChanged) {
    // The previous identity may have rendered appearance values this scope has
    // never seen (absent from both prefs and this scope's last-seen); clear
    // them back to defaults so the new identity never wears the old one's look.
    for (const prefKey of SYNCED_PREF_KEYS) {
      if (
        isAppearancePref(prefKey) &&
        !(prefKey in prefs) &&
        !(shadowPrefs && prefKey in shadowPrefs) &&
        !retainedLocalKeys.has(prefKey) &&
        SYNCED_PREFS[prefKey].clearable
      ) {
        (changed as Record<string, unknown>)[prefKey] = null;
      }
    }
  }
  writeStorage(LAST_SEEN_KEY, scope, key);
  if (retainedLocalKeys.size) {
    updateRetainedLocalKeys(scope, [...retainedLocalKeys], false);
  }
  recordReconciledObject();
  if (Object.hasOwn(changed, "theme")) {
    hooks.onThemeChanged?.(changed.theme ?? null);
  }
  const patch = serverPrefsLocalPatch(changed, loadSettings());
  if (!patch) {
    return false;
  }
  applyingServerPrefs = true;
  try {
    patchSettings(patch);
  } finally {
    applyingServerPrefs = false;
  }
  hooks.onApplied(patch);
  return true;
}

export async function refreshProfileAppearancePrefs(options: {
  client: GatewayBrowserClient;
  profileId: string;
  configObject: unknown;
  scope?: string;
  onApplied: (patch: Partial<UiSettings>) => void;
  onThemeChanged?: (theme: ThemeName | null) => void;
}): Promise<boolean> {
  const scope = options.scope ?? options.client.gatewayUrl;
  if (!(await loadProfileAppearancePrefs(options.client, options.profileId, scope))) {
    return false;
  }
  lastReconciledConfigObject = null;
  return applyServerUiPrefs(options.configObject, { ...options, scope });
}
export function isApplyingServerUiPrefs(): boolean {
  return applyingServerPrefs;
}
function adoptPushWriter(writer: ServerUiPrefsWriter, hooks: ServerUiPrefsPushHooks): void {
  const profileId = hooks.profileId ?? hooks.profile?.selfUser?.id ?? null;
  const scope = resolveProfilePreferenceScope(writer.state.client?.gatewayUrl ?? "", profileId);
  pushCanWrite = hooks.canWrite ?? hasOperatorWriteAccess(hooks.profile?.hello?.auth ?? null);
  if (pushWriter === writer && pushScope === scope && pushProfileId === profileId) {
    return;
  }
  // Reconcile the scope being left before moving pre-connection intent forward.
  // Otherwise another tab can cancel storage while this realm later resurrects its stale memory.
  reconcilePersistedPendingPrefs();
  const unscopedPending =
    pendingScope === ""
      ? {
          ...parseStoredPrefs(readStorage(PENDING_KEY, "")),
          ...pendingPrefs,
        }
      : null;
  clearConflictRedrain();
  pushEpoch += 1;
  pushWriter = writer;
  pushScope = scope;
  pushProfileId = profileId;
  pushDraining = false;
  adoptPendingScope(scope, true);
  if (scope && unscopedPending && Object.keys(unscopedPending).length) {
    // A preference can be edited before the first gateway client is adopted.
    // Move only that unscoped intent forward; preferences from one real
    // gateway must never bleed into another gateway's scope.
    pendingPrefs = { ...pendingPrefs, ...unscopedPending };
    mergePendingIntoStorage();
    writeStorage(PENDING_KEY, "", null);
  }
}
function removeBatch(batch: ServerUiPrefs): void {
  if (!pendingPrefs) {
    return;
  }
  for (const key of Object.keys(batch) as SyncedPrefKey[]) {
    if (prefValuesEqual(pendingPrefs[key], batch[key])) {
      delete pendingPrefs[key];
      pendingPersistedKeys.delete(key);
    }
  }
  if (!Object.keys(pendingPrefs).length) {
    pendingPrefs = null;
  }
}
// Conflicts mean another writer committed, so bounded rescheduling converges under progress.
// The cap prevents an endlessly conflicting server from keeping a timer chain alive.
function scheduleConflictRedrain(writer: ServerUiPrefsWriter, epoch: number): void {
  if (conflictRedrainTimer !== null || consecutiveConflictRedrains >= MAX_CONFLICT_REDRAINS) {
    return;
  }
  consecutiveConflictRedrains += 1;
  conflictRedrainTimer = setTimeout(() => {
    conflictRedrainTimer = null;
    if (pushWriter === writer && pushEpoch === epoch && pendingPrefs) {
      startPendingDrain(writer);
    }
  }, CONFLICT_REDRAIN_DELAY_MS);
}

async function drainPendingPrefs(writer: ServerUiPrefsWriter, epoch: number): Promise<void> {
  while (pendingPrefs) {
    if (pushWriter !== writer || pushEpoch !== epoch) {
      return;
    }
    reconcilePersistedPendingPrefs();
    if (!pendingPrefs) {
      return;
    }
    const localOnlyKeys = SYNCED_PREF_KEYS.filter(
      (key) =>
        pendingPrefs?.[key] !== undefined &&
        SYNCED_PREFS[key].configSync === false &&
        !(pushProfileId && pushCanWrite),
    );
    if (localOnlyKeys.length) {
      if (!writer.state.connected) {
        return;
      }
      // Profile-only preferences must never fall through to config.patch,
      // including intent queued before this connection's identity was known.
      cancelPendingKeys(pendingScope, localOnlyKeys);
      updateRetainedLocalKeys(pendingScope, localOnlyKeys, true);
      pushAfterCommit?.({ needsRefresh: false, retainedLocal: true });
      continue;
    }
    if (pushProfileId && pendingPrefs.theme === "custom") {
      // Offline-queued custom theme reaching a profile connection: browser-local
      // by contract, so retain it here instead of syncing it to the profile.
      cancelPendingKeys(pendingScope, ["theme"]);
      updateRetainedLocalKeys(pendingScope, ["theme"], true);
      continue;
    }
    const profileBatch: ServerUiPrefs = {};
    if (pushProfileId && pushCanWrite) {
      for (const key of SYNCED_PREF_KEYS) {
        if (isAppearancePref(key) && Object.hasOwn(pendingPrefs, key)) {
          Object.assign(profileBatch, { [key]: pendingPrefs[key] });
        }
      }
    }
    const useProfile = Boolean(profileBatch && Object.keys(profileBatch).length);
    const batch = useProfile ? profileBatch : { ...pendingPrefs };
    const afterCommit = pushAfterCommit;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (pushWriter !== writer || pushEpoch !== epoch) {
        return;
      }
      const result = useProfile
        ? await writeProfileAppearancePrefs(
            writer.state.client,
            batch,
            writer.state.connected && pushCanWrite && batchIsCurrent(batch),
          )
        : await writer.runExternalMutation(
            (client) =>
              // ui.prefs is a deliberately narrow hashless LWW surface enforced by
              // hasHashlessPatchLwwStructure in the gateway. Serialization still
              // matters: a pending whole-config save must commit before this merge.
              client.request("config.patch", {
                raw: JSON.stringify({ ui: { prefs: batch } }),
                ...(batch.sidebarEntries !== undefined
                  ? { replacePaths: ["ui.prefs.sidebarEntries"] }
                  : {}),
                note: "control-ui prefs sync",
              }),
            {
              waitForWritesResumed: true,
              canDispatch: () => {
                if (writer.canPatch === false) {
                  return false;
                }
                reconcilePersistedPendingPrefs();
                if (batchIsCurrent(batch)) {
                  return true;
                }
                drainRequested = Boolean(pendingPrefs);
                return false;
              },
              dispatchError: "Access changed before preferences could sync.",
            },
          );
      if (pushWriter !== writer || pushEpoch !== epoch) {
        return;
      }
      if (result.ok) {
        removeBatch(batch);
        const lastSeen = parseStoredPrefs(readStorage(LAST_SEEN_KEY, pendingScope)) ?? {};
        const nextLastSeen = { ...lastSeen, ...batch };
        const profilePrefs = resolveProfileAppearancePrefs(
          writer.state.client?.gatewayUrl ?? "",
          pushProfileId,
        );
        if (useProfile && profilePrefs) {
          const configPrefs = extractServerUiPrefs(writer.state.configSnapshot?.config);
          for (const key of SYNCED_PREF_KEYS) {
            if (!Object.hasOwn(batch, key)) {
              continue;
            }
            if (batch[key] === null) {
              delete profilePrefs[key];
              if (configPrefs[key] === undefined) {
                delete nextLastSeen[key];
              } else {
                Object.assign(nextLastSeen, { [key]: configPrefs[key] });
              }
            } else {
              Object.assign(profilePrefs, { [key]: batch[key] });
            }
          }
          lastReconciledConfigObject = null;
        }
        writeStorage(LAST_SEEN_KEY, pendingScope, JSON.stringify(nextLastSeen));
        settlePendingStorage(batch);
        clearConflictRedrain();
        if (pushWriter !== writer || pushEpoch !== epoch) {
          return;
        }
        if (result.refresh.ok && afterCommit && lastReconciledScope === pendingScope) {
          // The authoritative refresh published while pending intent still
          // shadowed this batch. Re-evaluate that same snapshot after cleanup
          // so a concurrent server value wins without another config.get.
          lastReconciledConfigObject = null;
        }
        afterCommit?.({ needsRefresh: !result.refresh.ok });
        if (pushWriter !== writer || pushEpoch !== epoch) {
          return;
        }
        break;
      }
      if (result.reason === "conflict" && attempt === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        continue;
      }
      if (result.reason === "conflict") {
        scheduleConflictRedrain(writer, epoch);
        return;
      }
      if (
        result.reason === "error" ||
        result.reason === "unavailable" ||
        result.reason === "suspended"
      ) {
        return;
      }
      // Definitive viewer-scope or validation rejections degrade to device-local state.
      // LAST_SEEN still owns the authoritative server value per key, so identical
      // refreshes and reloads preserve this local edit; only a server delta replaces it.
      removeBatch(batch);
      settlePendingStorage(batch);
      afterCommit?.({ needsRefresh: false, retainedLocal: true });
      return;
    }
  }
}
function startPendingDrain(writer: ServerUiPrefsWriter): void {
  if (pushDraining) {
    drainRequested = true;
    return;
  }
  if (!pendingPrefs) {
    return;
  }
  if (
    writer.state.connected &&
    writer.canPatch === false &&
    !(pushProfileId && pushCanWrite && Object.keys(pendingPrefs).some(isAppearancePref))
  ) {
    return;
  }
  pushDraining = true;
  const epoch = pushEpoch;
  void drainPendingPrefs(writer, epoch)
    .catch(() => undefined)
    .finally(() => {
      if (pushWriter === writer && pushEpoch === epoch) {
        pushDraining = false;
        if (drainRequested) {
          drainRequested = false;
          startPendingDrain(writer);
        }
      }
    });
}
export function pushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  prefs: ServerUiPrefs,
  hooks: ServerUiPrefsPushHooks = {},
): void {
  adoptPushWriter(writer, hooks);
  clearConflictRedrain();
  pushAfterCommit = hooks.afterCommit;
  const keys = SYNCED_PREF_KEYS.filter((key) => Object.hasOwn(prefs, key));
  const blockedKeys = writer.state.connected
    ? keys.filter((key) => {
        if (SYNCED_PREFS[key].configSync === false && !pushProfileId) {
          return true;
        }
        if (pushProfileId && isAppearancePref(key)) {
          // Imported custom palettes are browser-local by contract; a profile
          // must never carry a theme another browser cannot render.
          return !pushCanWrite || (key === "theme" && prefs.theme === "custom");
        }
        return writer.canPatch === false;
      })
    : [];
  if (blockedKeys.length) {
    // A connected read-only edit is intentionally browser-local. Supersede only
    // same-key offline intent so a later authorization cannot replay stale input.
    cancelPendingKeys(pendingScope, blockedKeys);
    updateRetainedLocalKeys(pendingScope, blockedKeys, true);
    hooks.afterCommit?.({ needsRefresh: false, retainedLocal: true });
    if (blockedKeys.length === keys.length) {
      return;
    }
  }
  const writablePrefs = blockedKeys.length
    ? Object.fromEntries(
        Object.entries(prefs).filter(
          ([key]) => !blockedKeys.some((blockedKey) => blockedKey === key),
        ),
      )
    : prefs;
  reconcilePersistedPendingPrefs();
  pendingPrefs = { ...pendingPrefs, ...writablePrefs };
  mergePendingIntoStorage();
  startPendingDrain(writer);
}
export function flushServerUiPrefs(
  writer: ServerUiPrefsWriter,
  hooks: ServerUiPrefsPushHooks = {},
): void {
  adoptPushWriter(writer, hooks);
  clearConflictRedrain();
  pushEpoch += 1;
  pushDraining = drainRequested = false;
  pushAfterCommit = hooks.afterCommit;
  startPendingDrain(writer);
}
