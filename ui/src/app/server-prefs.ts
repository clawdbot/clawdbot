// Server ui.prefs is canonical; pending local intent shadows snapshots until hash-free LWW ack.
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
const SYNCED_PREFS = {
  theme: prefSpec<ThemeName>({
    extract: (value) => (THEMES.has(value as ThemeName) ? (value as ThemeName) : undefined),
    local: (settings) => settings.theme,
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
      if (specification.clearable) {
        (prefs as Record<string, unknown>)[key] = null;
      }
      continue;
    }
    (prefs as Record<string, unknown>)[key] = nextValue;
  }
  return Object.keys(prefs).length > 0 ? prefs : null;
}
const LAST_SEEN_KEY = "openclaw.control.serverPrefs.v1";
const PENDING_KEY = "openclaw.control.serverPrefs.pending.v1";
let applyingServerPrefs = false;
let pendingScope = "";
let pendingPrefs: ServerUiPrefs | null = null;
let pushClient: GatewayBrowserClient | null = null;
let pushAfterCommit: (() => void) | undefined;
let pushDraining = false;
let drainRequested = false;
let pushEpoch = 0;
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
  } catch {}
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
function persistPendingPrefs(): void {
  const value = pendingPrefs ? JSON.stringify(pendingPrefs) : null;
  writeStorage(PENDING_KEY, pendingScope, value);
}
export function resetServerUiPrefsSync() {
  applyingServerPrefs = pushDraining = drainRequested = false;
  pendingScope = "";
  pendingPrefs = pushClient = null;
}
export function applyServerUiPrefs(
  configObject: unknown,
  hooks: {
    scope?: string;
    onApplied: (patch: Partial<UiSettings>) => void;
  },
): boolean {
  const scope = hooks.scope ?? "";
  const shadowPrefs =
    scope === pendingScope ? pendingPrefs : parseStoredPrefs(readStorage(PENDING_KEY, scope));
  const prefs = extractServerUiPrefs(configObject);
  const key = JSON.stringify(prefs);
  const lastSeenRaw = readStorage(LAST_SEEN_KEY, scope);
  if (key === lastSeenRaw) {
    return false;
  }
  const lastSeen = parseStoredPrefs(lastSeenRaw) ?? {};
  const changed: ServerUiPrefs = {};
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
        persistPendingPrefs();
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
        if (conflict || !client.connected) {
          return;
        }
        removeBatch(batch);
        persistPendingPrefs();
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
  pendingPrefs = { ...pendingPrefs, ...prefs };
  pushAfterCommit = hooks.afterCommit;
  persistPendingPrefs();
  startPendingDrain(client);
}
export function flushServerUiPrefs(
  client: GatewayBrowserClient,
  hooks: { afterCommit?: () => void } = {},
): void {
  adoptPushClient(client);
  pushEpoch += 1;
  pushDraining = drainRequested = false;
  pushAfterCommit = hooks.afterCommit;
  startPendingDrain(client);
}
