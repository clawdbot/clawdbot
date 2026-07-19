// Server-side operator display prefs (config ui.prefs) with a browser-local
// mirror. The config value is canonical — agents change it through the
// approval gate and other devices pick it up — while localStorage keeps
// instant boot and stays authoritative when this client cannot write config
// (viewer scope, offline). Sync policy: a server-side *change* wins over the
// local mirror; an unchanged server value never reverts local edits, so a
// failed push degrades to device-local behavior instead of flip-flopping.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  loadSettings,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  normalizeTextScale,
  patchSettings,
  TEXT_SCALE_STOPS,
  type ChatFollowUpMode,
  type ChatSendShortcut,
  type TextScaleStop,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";

const THEMES: ReadonlySet<ThemeName> = new Set(["claw", "knot", "dash", "custom"]);
const THEME_MODES: ReadonlySet<ThemeMode> = new Set(["light", "dark", "system"]);

/**
 * One descriptor per synced pref — the single source of truth for what syncs
 * through config ui.prefs. Each key defines how to validate the server value,
 * read the normalized local value, and (optionally) whether a server value is
 * applicable on this device. `clearable` keys push an explicit JSON null when
 * unset locally so the merge patch removes them server-side.
 */
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

const SYNCED_PREFS = {
  theme: prefSpec<ThemeName>({
    extract: (value) => (THEMES.has(value as ThemeName) ? (value as ThemeName) : undefined),
    local: (settings) => settings.theme,
    // A server "custom" theme is only honorable once this browser imported
    // one; the imported palette itself is too large to live in config.
    canApply: (value, settings) => value !== "custom" || Boolean(settings.customTheme),
  }),
  themeMode: prefSpec<ThemeMode>({
    extract: (value) => (THEME_MODES.has(value as ThemeMode) ? (value as ThemeMode) : undefined),
    local: (settings) => settings.themeMode,
  }),
  textScale: prefSpec<TextScaleStop>({
    extract: (value) =>
      TEXT_SCALE_STOPS.includes(value as TextScaleStop) ? normalizeTextScale(value) : undefined,
    local: (settings) => normalizeTextScale(settings.textScale),
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
    local: (settings) => settings.chatPersistCommentary ?? false,
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
    // Unset means "use the server-configured queue mode"; clearing must
    // propagate, so the push serializes an explicit null removal.
    clearable: true,
  }),
  sidebarEntries: prefSpec<string[]>({
    extract: (value) => normalizeSidebarEntries(value) ?? undefined,
    local: (settings) => settings.sidebarEntries,
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
    // Null marks a server-side removal of a clearable key: drop the local
    // override so this device falls back to the server-configured behavior.
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

// Last server value this client reconciled against, persisted per gateway
// scope. Applying only on a server *delta* keeps an unpushable local edit
// (viewer scope) from being reverted by every later snapshot — including the
// first snapshot after a reload or reconnect — carrying the same old value.
const LAST_SEEN_STORAGE_KEY = "openclaw.control.serverPrefs.v1";

let lastSeenScope = "";
let lastSeenServerPrefsKey: string | null = null;
// Config hashes our patches replaced. A snapshot still carrying one of these
// hashes was fetched before the patch landed; applying it would revert the
// pushed value as if the server had changed it back. CAS guarantees the
// replaced config had exactly the base hash, so this check is precise.
const staleConfigHashes = new Set<string>();
const STALE_CONFIG_HASH_LIMIT = 8;
let applyingServerPrefs = false;

function loadLastSeenKey(scope: string): string | null {
  if (scope !== lastSeenScope) {
    lastSeenScope = scope;
    try {
      lastSeenServerPrefsKey = globalThis.localStorage?.getItem(
        `${LAST_SEEN_STORAGE_KEY}:${scope}`,
      );
    } catch {
      lastSeenServerPrefsKey = null;
    }
  }
  return lastSeenServerPrefsKey;
}

function storeLastSeenKey(scope: string, key: string) {
  lastSeenScope = scope;
  lastSeenServerPrefsKey = key;
  try {
    globalThis.localStorage?.setItem(`${LAST_SEEN_STORAGE_KEY}:${scope}`, key);
  } catch {
    // Quota/security failures degrade to in-memory tracking for this session.
  }
}

export function resetServerUiPrefsSync() {
  lastSeenScope = "";
  lastSeenServerPrefsKey = null;
  staleConfigHashes.clear();
  applyingServerPrefs = false;
  queuedClient = null;
  queuedPrefs = null;
  pushDraining = false;
}

export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    snapshotHash?: string;
    onApplied: (patch: Partial<UiSettings>) => void;
  },
): boolean {
  if (hooks.snapshotHash) {
    if (staleConfigHashes.has(hooks.snapshotHash)) {
      return false;
    }
    // Post-patch state observed: retire the stale marks. Hashes identify
    // content, not age — if the pre-patch hash reappears later, another
    // writer genuinely restored that config and it is authoritative again.
    staleConfigHashes.clear();
  }
  const scope = hooks.scope ?? "";
  const prefs = extractServerUiPrefs(configObject);
  const key = JSON.stringify(prefs);
  const lastSeenRaw = loadLastSeenKey(scope);
  if (key === lastSeenRaw) {
    return false;
  }
  // Apply per field: only keys whose *server* value changed since last seen.
  // Reapplying unchanged fields would revert unpushable local edits on other
  // keys whenever any one server field moves.
  let lastSeen: ServerUiPrefs;
  try {
    lastSeen = lastSeenRaw ? (JSON.parse(lastSeenRaw) as ServerUiPrefs) : {};
  } catch {
    lastSeen = {};
  }
  const changed: ServerUiPrefs = {};
  for (const prefKey of Object.keys(prefs) as Array<keyof ServerUiPrefs>) {
    if (lastSeenRaw === null || prefs[prefKey] !== lastSeen[prefKey]) {
      (changed as Record<string, unknown>)[prefKey] = prefs[prefKey];
    }
  }
  // A clearable key that disappeared from the server was removed by another
  // writer; surface the removal as an explicit null so the local override
  // clears too (non-clearable keys keep their device-local value).
  for (const prefKey of Object.keys(lastSeen) as Array<keyof ServerUiPrefs>) {
    if (!(prefKey in prefs) && SYNCED_PREFS[prefKey]?.clearable) {
      (changed as Record<string, unknown>)[prefKey] = null;
    }
  }
  storeLastSeenKey(scope, key);
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

// Pending deltas coalesce into one object and drain serially, so rapid
// changes cannot race each other's CAS hash and silently drop an update. The
// queue is bound to one gateway client; switching gateways drops undelivered
// deltas for the old one (they stay device-local, per the sync contract).
let queuedClient: GatewayBrowserClient | null = null;
let queuedPrefs: ServerUiPrefs | null = null;
let pushDraining = false;

async function drainPrefsQueue(client: GatewayBrowserClient): Promise<void> {
  while (queuedPrefs) {
    // The awaits below can outlive a gateway switch; a superseded drain stops
    // instead of writing one gateway's prefs to another.
    if (queuedClient !== client) {
      return;
    }
    const prefs = queuedPrefs;
    queuedPrefs = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = (await client.request("config.get", {})) as { hash?: string } | null;
      const baseHash = snapshot?.hash;
      if (!baseHash || queuedClient !== client) {
        return;
      }
      try {
        await client.request("config.patch", {
          baseHash,
          raw: JSON.stringify({ ui: { prefs } }),
          note: "control-ui prefs sync",
        });
        staleConfigHashes.add(baseHash);
        if (staleConfigHashes.size > STALE_CONFIG_HASH_LIMIT) {
          const oldest = staleConfigHashes.values().next().value;
          if (oldest !== undefined) {
            staleConfigHashes.delete(oldest);
          }
        }
        break;
      } catch (error) {
        if (attempt === 0 && String(error).toLowerCase().includes("hash")) {
          continue;
        }
        return;
      }
    }
  }
}

/**
 * Best-effort write-through of a local pref change to config ui.prefs.
 * Silent on failure by design: clients without operator.admin (or offline)
 * keep the change device-local.
 */
export function pushServerUiPrefs(client: GatewayBrowserClient, prefs: ServerUiPrefs): void {
  if (queuedClient !== client) {
    // New gateway: abandon the old queue (its drain loop sees the client
    // change and stops) instead of writing one gateway's prefs to another.
    queuedClient = client;
    queuedPrefs = null;
    pushDraining = false;
  }
  queuedPrefs = { ...queuedPrefs, ...prefs };
  if (pushDraining) {
    return;
  }
  pushDraining = true;
  void drainPrefsQueue(client)
    .catch(() => undefined)
    .finally(() => {
      if (queuedClient === client) {
        pushDraining = false;
      }
    });
}
