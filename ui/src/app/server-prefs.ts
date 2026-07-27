// Server-side operator display prefs (config ui.prefs) are canonical: agents change them through
// the approval gate and other devices pick them up. The localStorage mirror gives instant boot and
// stays authoritative when this client cannot write config (viewer scope, offline). Pending local
// intent shadows server snapshots until the hash-free LWW ack; failed pushes degrade device-local.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  loadSettings,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  patchSettings,
  type ChatFollowUpMode,
  type ChatSendShortcut,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";
const THEMES: ReadonlySet<ThemeName> = new Set(["claw", "knot", "dash", "custom"]);
const THEME_MODES: ReadonlySet<ThemeMode> = new Set(["light", "dark", "system"]);
type SyncedPrefSpec<T> = {
  extract: (value: unknown) => T | undefined;
  local: (settings: UiSettings) => T | undefined;
  canApply?: (value: T, settings: UiSettings) => boolean;
  clearable?: boolean;
};
const prefSpec = <T>(specification: SyncedPrefSpec<T>) => specification;
function prefValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}
/**
 * One descriptor per synced pref — the single source of truth for what syncs
 * through config ui.prefs. Each key defines server validation, local normalization,
 * and applicability; `clearable` keys push an explicit JSON null when unset locally
 * so the merge patch removes them server-side.
 */
const SYNCED_PREFS = {
  theme: prefSpec<ThemeName>({
    extract: (value) => (THEMES.has(value as ThemeName) ? (value as ThemeName) : undefined),
    local: (settings) => settings.theme,
    // A server "custom" theme is only honorable once this browser imported one;
    // the imported palette itself is too large to live in config.
    canApply: (value, settings) => value !== "custom" || Boolean(settings.customTheme),
  }),
  themeMode: prefSpec<ThemeMode>({
    extract: (value) => (THEME_MODES.has(value as ThemeMode) ? (value as ThemeMode) : undefined),
    local: (settings) => settings.themeMode,
  }),
  locale: prefSpec<string>({
    extract: (value) => (typeof value === "string" && isSupportedLocale(value) ? value : undefined),
    local: (settings) => settings.locale,
  }),
  chatShowThinking: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatShowThinking,
  }),
  chatShowToolCalls: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatShowToolCalls,
  }),
  chatPersistCommentary: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.chatPersistCommentary !== false,
  }),
  chatSendShortcut: prefSpec<ChatSendShortcut>({
    extract: (value) =>
      value === "enter" || value === "modifier-enter"
        ? normalizeChatSendShortcut(value)
        : undefined,
    local: (settings) => normalizeChatSendShortcut(settings.chatSendShortcut),
  }),
  chatFollowUpMode: prefSpec<ChatFollowUpMode>({
    extract: (value) => normalizeChatFollowUpModeOverride(value),
    local: (settings) => normalizeChatFollowUpModeOverride(settings.chatFollowUpMode),
    // Unset means "use the server-configured queue mode"; clearing must propagate,
    // so the push serializes an explicit null removal.
    clearable: true,
  }),
  sidebarEntries: prefSpec<string[]>({
    extract: (value) => normalizeSidebarEntries(value) ?? undefined,
    local: (settings) => settings.sidebarEntries,
  }),
  showAdvancedSettings: prefSpec<boolean>({
    extract: (value) => (typeof value === "boolean" ? value : undefined),
    local: (settings) => settings.showAdvancedSettings === true,
  }),
} as const;
type SyncedPrefKey = keyof typeof SYNCED_PREFS;
type SyncedPrefValue<K extends SyncedPrefKey> =
  ReturnType<(typeof SYNCED_PREFS)[K]["extract"]> extends (infer T) | undefined ? T : never;
type ServerUiPrefs = { [K in SyncedPrefKey]?: SyncedPrefValue<K> | null };
const SYNCED_PREF_KEYS = Object.keys(SYNCED_PREFS) as SyncedPrefKey[];
function extractServerUiPrefs(configObject: unknown): ServerUiPrefs {
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  if (!prefs) {
    return {};
  }
  const result: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
    const value = SYNCED_PREFS[key].extract(prefs[key]);
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
/** Local-settings patch that would bring the mirror in line with the server. */
function serverPrefsLocalPatch(
  prefs: ServerUiPrefs,
  settings: UiSettings,
): Partial<UiSettings> | null {
  const patch: Partial<UiSettings> = {};
  for (const key of SYNCED_PREF_KEYS) {
    const specification = SYNCED_PREFS[key];
    const serverValue = prefs[key];
    if (serverValue === undefined) {
      continue;
    }
    // Null marks a server-side removal of a clearable key: drop the local override
    // so this device falls back to the server-configured behavior.
    if (serverValue === null) {
      if (specification.clearable && specification.local(settings) !== undefined) {
        (patch as Record<string, unknown>)[key] = undefined;
      }
      continue;
    }
    if (prefValuesEqual(serverValue, specification.local(settings))) {
      continue;
    }
    if (
      specification.canApply &&
      !(specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
        serverValue,
        settings,
      )
    ) {
      continue;
    }
    (patch as Record<string, unknown>)[key] = serverValue;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(previous: UiSettings, next: UiSettings): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  for (const key of SYNCED_PREF_KEYS) {
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
// Last server value this client reconciled against, persisted per gateway scope. Applying only on
// a server delta keeps an unpushable local edit (viewer scope) from being reverted by every later
// snapshot, including the first snapshot after reload or reconnect carrying the same old value.
const LAST_SEEN_KEY = "openclaw.control.serverPrefs.v1";
// Pending keys are local edits not yet acknowledged by the gateway. They shadow reconciliation so
// snapshots cannot revert unacked edits, and persist so offline edits replay after reload/reconnect.
const PENDING_KEY = "openclaw.control.serverPrefs.pending.v1";
const CONFLICT_REDRAIN_DELAY_MS = 1_000;
const MAX_CONFLICT_REDRAINS = 5;
let applyingServerPrefs = false;
let pendingScope = "";
let pendingPrefs: ServerUiPrefs | null = null;
let pushClient: GatewayBrowserClient | null = null;
let pushAfterCommit: (() => void) | undefined;
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
function readStorage(root: string, scope: string): string | null {
  try {
    return globalThis.localStorage?.getItem(`${root}:${scope}`) ?? null;
  } catch {
    return null;
  }
}
function writeStorage(root: string, scope: string, value: string | null): void {
  try {
    const key = `${root}:${scope}`;
    if (value === null) {
      globalThis.localStorage?.removeItem(key);
    } else {
      globalThis.localStorage?.setItem(key, value);
    }
  } catch {
    // Quota/security failures degrade to in-memory tracking for this session.
  }
}
function parseStoredPrefs(raw: string | null): ServerUiPrefs | null {
  try {
    const prefs = asRecord(JSON.parse(raw ?? "null"));
    return prefs && Object.keys(prefs).length ? (prefs as ServerUiPrefs) : null;
  } catch {
    return null;
  }
}
function adoptPendingScope(scope: string, force = false): void {
  if (!force && scope === pendingScope) {
    return;
  }
  pendingScope = scope;
  pendingPrefs = parseStoredPrefs(readStorage(PENDING_KEY, scope));
}
function writePendingStorage(prefs: ServerUiPrefs | null): void {
  writeStorage(PENDING_KEY, pendingScope, prefs ? JSON.stringify(prefs) : null);
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
export function resetServerUiPrefsSync() {
  clearConflictRedrain();
  applyingServerPrefs = pushDraining = drainRequested = false;
  pendingScope = "";
  pendingPrefs = pushClient = null;
  lastReconciledScope = "";
  lastReconciledConfigObject = null;
}
export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    onApplied: (patch: Partial<UiSettings>) => void;
  },
): boolean {
  const scope = hooks.scope ?? "";
  if (scope === lastReconciledScope && configObject === lastReconciledConfigObject) {
    return false;
  }
  const recordReconciledObject = () => {
    lastReconciledScope = scope;
    lastReconciledConfigObject = configObject;
  };
  const shadowPrefs =
    scope === pendingScope ? pendingPrefs : parseStoredPrefs(readStorage(PENDING_KEY, scope));
  const prefs = extractServerUiPrefs(configObject);
  const key = JSON.stringify(prefs);
  const lastSeenRaw = readStorage(LAST_SEEN_KEY, scope);
  if (key === lastSeenRaw) {
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
      (lastSeenRaw === null || !prefValuesEqual(prefs[prefKey], lastSeen[prefKey]))
    ) {
      (changed as Record<string, unknown>)[prefKey] = prefs[prefKey];
    }
  }
  for (const prefKey of Object.keys(lastSeen) as Array<keyof ServerUiPrefs>) {
    if (
      !(prefKey in prefs) &&
      !(shadowPrefs && prefKey in shadowPrefs) &&
      SYNCED_PREFS[prefKey]?.clearable
    ) {
      (changed as Record<string, unknown>)[prefKey] = null;
    }
  }
  writeStorage(LAST_SEEN_KEY, scope, key);
  recordReconciledObject();
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
export function isApplyingServerUiPrefs(): boolean {
  return applyingServerPrefs;
}
function adoptPushClient(client: GatewayBrowserClient): void {
  if (pushClient === client) {
    return;
  }
  clearConflictRedrain();
  pushEpoch += 1;
  pushClient = client;
  pushDraining = false;
  adoptPendingScope(client.gatewayUrl, true);
}
function removeBatch(batch: ServerUiPrefs): void {
  if (!pendingPrefs) {
    return;
  }
  for (const key of Object.keys(batch) as SyncedPrefKey[]) {
    if (prefValuesEqual(pendingPrefs[key], batch[key])) {
      delete pendingPrefs[key];
    }
  }
  if (!Object.keys(pendingPrefs).length) {
    pendingPrefs = null;
  }
}
// Conflicts mean another writer committed, so bounded rescheduling converges under progress.
// The cap prevents an endlessly conflicting server from keeping a timer chain alive.
function scheduleConflictRedrain(client: GatewayBrowserClient, epoch: number): void {
  if (conflictRedrainTimer !== null || consecutiveConflictRedrains >= MAX_CONFLICT_REDRAINS) {
    return;
  }
  consecutiveConflictRedrains += 1;
  conflictRedrainTimer = setTimeout(() => {
    conflictRedrainTimer = null;
    if (pushClient === client && pushEpoch === epoch && pendingPrefs) {
      startPendingDrain(client);
    }
  }, CONFLICT_REDRAIN_DELAY_MS);
}
async function drainPendingPrefs(client: GatewayBrowserClient, epoch: number): Promise<void> {
  while (pendingPrefs) {
    if (pushClient !== client || pushEpoch !== epoch) {
      return;
    }
    const batch = { ...pendingPrefs };
    const afterCommit = pushAfterCommit;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (pushClient !== client || pushEpoch !== epoch) {
        return;
      }
      try {
        await client.request("config.patch", {
          raw: JSON.stringify({ ui: { prefs: batch } }),
          ...(batch.sidebarEntries !== undefined
            ? { replacePaths: ["ui.prefs.sidebarEntries"] }
            : {}),
          note: "control-ui prefs sync",
        });
        if (pushClient !== client || pushEpoch !== epoch) {
          return;
        }
        // Start refresh while pending still shadows the pre-commit snapshot published by load.
        afterCommit?.();
        if (pushClient !== client || pushEpoch !== epoch) {
          return;
        }
        removeBatch(batch);
        const lastSeen = parseStoredPrefs(readStorage(LAST_SEEN_KEY, pendingScope)) ?? {};
        writeStorage(LAST_SEEN_KEY, pendingScope, JSON.stringify({ ...lastSeen, ...batch }));
        settlePendingStorage(batch);
        clearConflictRedrain();
        break;
      } catch (error) {
        if (pushClient !== client || pushEpoch !== epoch) {
          return;
        }
        const conflict = String(error).includes("config changed since last load");
        if (conflict && attempt === 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          });
          continue;
        }
        if (conflict) {
          scheduleConflictRedrain(client, epoch);
          return;
        }
        if (!client.connected) {
          return;
        }
        // Connected viewer-scope or validation failures degrade silently to device-local state;
        // connection loss and CAS conflicts retain pending intent for replay.
        removeBatch(batch);
        settlePendingStorage(batch);
        return;
      }
    }
  }
}
function startPendingDrain(client: GatewayBrowserClient): void {
  if (pushDraining) {
    drainRequested = true;
    return;
  }
  if (!pendingPrefs) {
    return;
  }
  pushDraining = true;
  const epoch = pushEpoch;
  void drainPendingPrefs(client, epoch)
    .catch(() => undefined)
    .finally(() => {
      if (pushClient === client && pushEpoch === epoch) {
        pushDraining = false;
        if (drainRequested) {
          drainRequested = false;
          startPendingDrain(client);
        }
      }
    });
}
export function pushServerUiPrefs(
  client: GatewayBrowserClient,
  prefs: ServerUiPrefs,
  hooks: { afterCommit?: () => void } = {},
): void {
  adoptPushClient(client);
  clearConflictRedrain();
  pendingPrefs = { ...pendingPrefs, ...prefs };
  pushAfterCommit = hooks.afterCommit;
  mergePendingIntoStorage();
  startPendingDrain(client);
}
export function flushServerUiPrefs(
  client: GatewayBrowserClient,
  hooks: { afterCommit?: () => void } = {},
): void {
  adoptPushClient(client);
  clearConflictRedrain();
  pushEpoch += 1;
  pushDraining = drainRequested = false;
  pushAfterCommit = hooks.afterCommit;
  startPendingDrain(client);
}
