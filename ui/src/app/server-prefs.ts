// Server-side operator display prefs (config ui.prefs) with a browser-local
// mirror. The config value is canonical — agents change it through the
// approval gate and other devices pick it up — while localStorage keeps
// instant boot and stays authoritative when this client cannot write config
// (viewer scope, offline). Sync policy: a server-side *change* wins over the
// local mirror; an unchanged server value never reverts local edits, so a
// failed push degrades to device-local behavior instead of flip-flopping.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  loadSettings,
  normalizeChatSendShortcut,
  normalizeTextScale,
  patchSettings,
  TEXT_SCALE_STOPS,
  type ChatSendShortcut,
  type TextScaleStop,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";

type ServerUiPrefs = {
  theme?: ThemeName;
  themeMode?: ThemeMode;
  textScale?: TextScaleStop;
  locale?: string;
  chatShowThinking?: boolean;
  chatShowToolCalls?: boolean;
  chatSendShortcut?: ChatSendShortcut;
};

const THEMES: ReadonlySet<ThemeName> = new Set(["claw", "knot", "dash", "custom"]);
const THEME_MODES: ReadonlySet<ThemeMode> = new Set(["light", "dark", "system"]);

function extractServerUiPrefs(configObject: unknown): ServerUiPrefs {
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  if (!prefs) {
    return {};
  }
  const result: ServerUiPrefs = {};
  if (THEMES.has(prefs.theme as ThemeName)) {
    result.theme = prefs.theme as ThemeName;
  }
  if (THEME_MODES.has(prefs.themeMode as ThemeMode)) {
    result.themeMode = prefs.themeMode as ThemeMode;
  }
  if (TEXT_SCALE_STOPS.includes(prefs.textScale as TextScaleStop)) {
    result.textScale = normalizeTextScale(prefs.textScale);
  }
  if (typeof prefs.locale === "string" && isSupportedLocale(prefs.locale)) {
    result.locale = prefs.locale;
  }
  if (typeof prefs.chatShowThinking === "boolean") {
    result.chatShowThinking = prefs.chatShowThinking;
  }
  if (typeof prefs.chatShowToolCalls === "boolean") {
    result.chatShowToolCalls = prefs.chatShowToolCalls;
  }
  if (prefs.chatSendShortcut === "enter" || prefs.chatSendShortcut === "modifier-enter") {
    result.chatSendShortcut = normalizeChatSendShortcut(prefs.chatSendShortcut);
  }
  return result;
}

/** Local-settings patch that would bring the mirror in line with the server. */
function serverPrefsLocalPatch(
  prefs: ServerUiPrefs,
  settings: UiSettings,
): Partial<UiSettings> | null {
  const patch: Partial<UiSettings> = {};
  // A server "custom" theme is only honorable once this browser imported one;
  // the imported palette itself is too large to live in config.
  if (prefs.theme !== undefined && prefs.theme !== settings.theme) {
    if (prefs.theme !== "custom" || settings.customTheme) {
      patch.theme = prefs.theme;
    }
  }
  if (prefs.themeMode !== undefined && prefs.themeMode !== settings.themeMode) {
    patch.themeMode = prefs.themeMode;
  }
  if (prefs.textScale !== undefined && prefs.textScale !== normalizeTextScale(settings.textScale)) {
    patch.textScale = prefs.textScale;
  }
  if (prefs.locale !== undefined && prefs.locale !== settings.locale) {
    patch.locale = prefs.locale;
  }
  if (
    prefs.chatShowThinking !== undefined &&
    prefs.chatShowThinking !== settings.chatShowThinking
  ) {
    patch.chatShowThinking = prefs.chatShowThinking;
  }
  if (
    prefs.chatShowToolCalls !== undefined &&
    prefs.chatShowToolCalls !== settings.chatShowToolCalls
  ) {
    patch.chatShowToolCalls = prefs.chatShowToolCalls;
  }
  if (
    prefs.chatSendShortcut !== undefined &&
    prefs.chatSendShortcut !== normalizeChatSendShortcut(settings.chatSendShortcut)
  ) {
    patch.chatSendShortcut = prefs.chatSendShortcut;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Synced-key delta between two local settings snapshots, for the push path. */
export function changedServerUiPrefs(previous: UiSettings, next: UiSettings): ServerUiPrefs | null {
  const prefs: ServerUiPrefs = {};
  if (next.theme !== previous.theme) {
    prefs.theme = next.theme;
  }
  if (next.themeMode !== previous.themeMode) {
    prefs.themeMode = next.themeMode;
  }
  if (normalizeTextScale(next.textScale) !== normalizeTextScale(previous.textScale)) {
    prefs.textScale = normalizeTextScale(next.textScale);
  }
  if (next.locale !== previous.locale && next.locale) {
    prefs.locale = next.locale;
  }
  if (next.chatShowThinking !== previous.chatShowThinking) {
    prefs.chatShowThinking = next.chatShowThinking;
  }
  if (next.chatShowToolCalls !== previous.chatShowToolCalls) {
    prefs.chatShowToolCalls = next.chatShowToolCalls;
  }
  if (
    normalizeChatSendShortcut(next.chatSendShortcut) !==
    normalizeChatSendShortcut(previous.chatSendShortcut)
  ) {
    prefs.chatSendShortcut = normalizeChatSendShortcut(next.chatSendShortcut);
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
