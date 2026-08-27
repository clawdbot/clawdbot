import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { UI_APPEARANCE_THEME_VALUES } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { normalizeSidebarEntries } from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import {
  normalizeAccentColor,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
  type ChatFollowUpMode,
  type ChatSendShortcut,
  type UiSettings,
} from "./settings.ts";
import type { ThemeMode, ThemeName } from "./theme.ts";

// Derived from the wire contract so a theme the profile store rejects can never
// be offered here; new Set<ThemeName> makes an unknown protocol name a type error.
// "custom" is config-syncable (honored only by browsers with an imported
// palette) but intentionally not profile-storable, so it is appended here
// rather than added to the wire contract.
const THEMES: ReadonlySet<ThemeName> = new Set<ThemeName>([
  ...UI_APPEARANCE_THEME_VALUES,
  "custom",
]);

export function isAppearancePref(key: string): key is "theme" | "themeMode" | "accent" {
  return key === "theme" || key === "themeMode" || key === "accent";
}
const THEME_MODES: ReadonlySet<ThemeMode> = new Set(["light", "dark", "system"]);

type SyncedPrefSpec<T> = {
  extract: (value: unknown) => T | undefined;
  local: (settings: UiSettings) => T | undefined;
  write?: (value: T | undefined) => Partial<UiSettings>;
  canApply?: (value: T, settings: UiSettings) => boolean;
  clearable?: boolean;
  reset?: (settings: UiSettings) => Partial<UiSettings>;
};

const prefSpec = <T>(specification: SyncedPrefSpec<T>) => specification;

/**
 * One descriptor per synced pref: the source of truth for config ui.prefs.
 * Each key owns server validation, local normalization, and applicability.
 */
export const SYNCED_PREFS = {
  theme: prefSpec<ThemeName>({
    extract: (value) => (THEMES.has(value as ThemeName) ? (value as ThemeName) : undefined),
    local: (settings) => settings.theme,
    write: (value) => ({ theme: value ?? UI_APPEARANCE_DEFAULTS.theme }),
    clearable: true,
    reset: () => ({ theme: UI_APPEARANCE_DEFAULTS.theme }),
    // A server "custom" theme is only honorable once this browser imported one;
    // the imported palette itself is too large to live in config.
    canApply: (value, settings) => value !== "custom" || Boolean(settings.customTheme),
  }),
  themeMode: prefSpec<ThemeMode>({
    extract: (value) => (THEME_MODES.has(value as ThemeMode) ? (value as ThemeMode) : undefined),
    local: (settings) => settings.themeMode,
    write: (value) => ({ themeMode: value ?? UI_APPEARANCE_DEFAULTS.themeMode }),
    clearable: true,
    reset: () => ({ themeMode: UI_APPEARANCE_DEFAULTS.themeMode }),
  }),
  accent: prefSpec<string>({
    extract: normalizeAccentColor,
    local: (settings) => normalizeAccentColor(settings.accent),
    write: (value) => ({ accent: value }),
    clearable: true,
    reset: () => ({ accent: undefined }),
  }),
  locale: prefSpec<string>({
    extract: (value) => (typeof value === "string" && isSupportedLocale(value) ? value : undefined),
    local: (settings) => settings.locale,
    write: (value) => ({ locale: value }),
    clearable: true,
    reset: () => ({ locale: undefined }),
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
    write: (value) => ({ chatSendShortcut: value }),
    clearable: true,
    reset: () => ({ chatSendShortcut: undefined }),
  }),
  chatFollowUpMode: prefSpec<ChatFollowUpMode>({
    extract: (value) => normalizeChatFollowUpModeOverride(value),
    local: (settings) => normalizeChatFollowUpModeOverride(settings.chatFollowUpMode),
    write: (value) => ({ chatFollowUpMode: value }),
    // Unset means "use the server-configured queue mode"; clearing must propagate,
    // so the push serializes an explicit null removal.
    clearable: true,
    reset: () => ({ chatFollowUpMode: undefined }),
  }),
  sidebarEntries: prefSpec<string[]>({
    extract: (value) => normalizeSidebarEntries(value) ?? undefined,
    local: (settings) => settings.sidebarEntries,
  }),
} as const;

export type SyncedPrefKey = keyof typeof SYNCED_PREFS;
export type ResettableServerUiPrefKey =
  | "theme"
  | "themeMode"
  | "accent"
  | "locale"
  | "chatSendShortcut"
  | "chatFollowUpMode";
export type SyncedPrefValue<K extends SyncedPrefKey> =
  ReturnType<(typeof SYNCED_PREFS)[K]["extract"]> extends (infer T) | undefined ? T : never;
export type ServerUiPrefs = { [K in SyncedPrefKey]?: SyncedPrefValue<K> | null };
export type ServerUiPrefProvenance = "default" | "pending" | "synced" | "profile" | "device-local";
export type ServerUiPrefState<T> = {
  overridden: boolean;
  provenance: ServerUiPrefProvenance;
  resetValue: T | undefined;
  value: T | undefined;
};

export const SYNCED_PREF_KEYS = Object.keys(SYNCED_PREFS) as SyncedPrefKey[];

export function prefValuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function applyChangedSettingsPatch(
  target: Partial<UiSettings>,
  settings: UiSettings,
  source: Partial<UiSettings>,
): void {
  const applyKey = <K extends keyof UiSettings>(key: K, value: UiSettings[K] | undefined) => {
    if (!prefValuesEqual(settings[key], value)) {
      target[key] = value;
    }
  };
  for (const key of Object.keys(source) as Array<keyof UiSettings>) {
    applyKey(key, source[key]);
  }
}

export function extractServerUiPrefs(configObject: unknown): ServerUiPrefs {
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

export function resolveServerUiPrefStateFromSnapshot<K extends SyncedPrefKey>(
  configObject: unknown,
  key: K,
  shadowPrefs: ServerUiPrefs | null,
  settings: UiSettings,
  canSync?: boolean | null,
  profilePrefs?: ServerUiPrefs | null,
): ServerUiPrefState<SyncedPrefValue<K>> {
  const specification = SYNCED_PREFS[key];
  const localValue = specification.local(settings) as SyncedPrefValue<K> | undefined;
  const resetPatch = specification.reset?.(settings);
  const productDefault = (
    resetPatch ? specification.local({ ...settings, ...resetPatch }) : undefined
  ) as SyncedPrefValue<K> | undefined;
  const localState = (
    resetValue: SyncedPrefValue<K> | undefined,
  ): ServerUiPrefState<SyncedPrefValue<K>> => {
    const overridden = !prefValuesEqual(localValue, resetValue);
    return {
      overridden,
      provenance: overridden ? "device-local" : "default",
      resetValue,
      value: localValue,
    };
  };
  const prefs = asRecord(asRecord(asRecord(configObject)?.ui)?.prefs);
  const configValue =
    prefs && Object.hasOwn(prefs, key)
      ? (specification.extract(prefs[key]) as SyncedPrefValue<K> | undefined)
      : undefined;
  const profileValue = profilePrefs?.[key] ?? undefined;
  const serverValue = profileValue ?? configValue;
  const isProfileValue = profileValue !== undefined;
  // With a profile active, reset deletes the profile key (even when none exists
  // yet), so the reset target is what that deletion falls back to — the gateway
  // value. Using the product default here misclassifies an explicit selection of
  // the product default as a reset and silently drops the user's choice.
  const resetsProfileKey = profilePrefs != null && isAppearancePref(key);
  const resetValue = resetsProfileKey ? (configValue ?? productDefault) : productDefault;
  const canApplyServerValue =
    serverValue !== undefined &&
    (!specification.canApply ||
      (specification.canApply as (value: unknown, settings: UiSettings) => boolean)(
        serverValue,
        settings,
      ));
  const applicableServerValue = canApplyServerValue ? serverValue : productDefault;
  if (shadowPrefs && key in shadowPrefs) {
    if (canSync === false) {
      return {
        ...localState(applicableServerValue),
        // Keep queued intent for a later authorized reconnect without claiming
        // that this connected read-only browser is pending a server sync.
        provenance: "device-local",
      };
    }
    const shadowValue = shadowPrefs[key];
    if (shadowValue === null) {
      return { ...localState(resetValue), provenance: "pending" };
    }
    return {
      overridden: true,
      provenance: "pending",
      resetValue,
      value: shadowValue as SyncedPrefValue<K>,
    };
  }
  if ((!prefs || !Object.hasOwn(prefs, key)) && !isProfileValue) {
    return localState(productDefault);
  }
  if (serverValue === undefined) {
    return localState(productDefault);
  }
  if (!canApplyServerValue) {
    if (canSync === false) {
      return localState(productDefault);
    }
    // Preserve authored server provenance even when this browser cannot render
    // the value, so Restore default still removes the server override.
    return {
      overridden: true,
      provenance: isProfileValue ? "profile" : "synced",
      resetValue,
      value: localValue,
    };
  }
  if (prefValuesEqual(localValue, serverValue)) {
    return {
      overridden: true,
      provenance: isProfileValue ? "profile" : "synced",
      resetValue,
      value: serverValue,
    };
  }
  return localState(serverValue);
}

/** Local-settings patch that brings the browser mirror in line with the server. */
export function serverPrefsLocalPatch(
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
      const resetPatch = specification.clearable ? specification.reset?.(settings) : undefined;
      if (resetPatch) {
        applyChangedSettingsPatch(patch, settings, resetPatch);
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
