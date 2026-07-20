// Control UI module implements storage behavior.
const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const LEGACY_SETTINGS_KEY = "openclaw.control.settings.v1";
export const NAV_WIDTH_MIN = 240;
export const NAV_WIDTH_MAX = 400;
const NAV_WIDTH_DEFAULT = 258;
const CURRENT_GATEWAY_SELECTION_KEY_PREFIX = "openclaw.control.currentGateway.v1:";
const LOCAL_USER_IDENTITY_KEY = "openclaw.control.user.v1";
const LEGACY_TOKEN_SESSION_KEY = "openclaw.control.token.v1";
const TOKEN_SESSION_KEY_PREFIX = "openclaw.control.token.v1:";
const MAX_SCOPED_SESSION_ENTRIES = 10;

function settingsKeyForGateway(gatewayUrl: string): string {
  return `${SETTINGS_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

function currentGatewaySelectionKeyForPage(pageUrl: string): string {
  return `${CURRENT_GATEWAY_SELECTION_KEY_PREFIX}${normalizeGatewayTokenScope(pageUrl)}`;
}

type ScopedSessionSelection = {
  sessionKey: string;
  lastActiveSessionKey: string;
};

type PersistedUiSettings = Omit<UiSettings, "token" | "sessionKey" | "lastActiveSessionKey"> & {
  token?: never;
  sessionKey?: string;
  lastActiveSessionKey?: string;
  sessionsByGateway?: Record<string, ScopedSessionSelection>;
};

import {
  DEFAULT_SIDEBAR_ENTRIES,
  normalizeSidebarEntries,
  SIDEBAR_NAV_ROUTES,
  serializeSidebarEntry,
} from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import { normalizeBoardSessionViews, type BoardSessionViews } from "../lib/board/settings.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";
import { normalizeChatSplitLayout, type ChatSplitLayout } from "../pages/chat/split-layout.ts";
import { resolveControlUiBasePath } from "./browser.ts";
import { parseImportedCustomTheme, type ImportedCustomTheme } from "./custom-theme.ts";
import { normalizeGatewayTokenScope } from "./gateway-scope.ts";
import { normalizePinnedAgentIds } from "./settings-normalizers.ts";
import { parseThemeSelection, type ThemeMode, type ThemeName } from "./theme.ts";
import { normalizeLocalUserIdentity, type LocalUserIdentity } from "./user-identity.ts";

export const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;
export type TextScaleStop = (typeof TEXT_SCALE_STOPS)[number];

const CHAT_SEND_SHORTCUTS = ["enter", "modifier-enter"] as const;
export type ChatSendShortcut = (typeof CHAT_SEND_SHORTCUTS)[number];

function normalizeChoice<T extends string>(
  values: readonly T[],
  fallback: T,
): (value: unknown) => T {
  return (value) => (values.includes(value as T) ? (value as T) : fallback);
}

export const normalizeChatSendShortcut = normalizeChoice(CHAT_SEND_SHORTCUTS, "enter");

const CHAT_FOLLOW_UP_MODES = ["queue", "steer"] as const;
export type ChatFollowUpMode = (typeof CHAT_FOLLOW_UP_MODES)[number];

export const normalizeChatFollowUpMode = normalizeChoice(CHAT_FOLLOW_UP_MODES, "steer");

export function normalizeChatFollowUpModeOverride(value: unknown): ChatFollowUpMode | undefined {
  return CHAT_FOLLOW_UP_MODES.includes(value as ChatFollowUpMode)
    ? (value as ChatFollowUpMode)
    : undefined;
}

const CATALOG_OPEN_TARGETS = ["viewer", "terminal"] as const;
export type CatalogOpenTarget = (typeof CATALOG_OPEN_TARGETS)[number];

export const normalizeCatalogOpenTarget = normalizeChoice(CATALOG_OPEN_TARGETS, "viewer");

const CHAT_WORKSPACE_DOCKS = ["right", "bottom"] as const;
export type ChatWorkspaceDock = (typeof CHAT_WORKSPACE_DOCKS)[number];

export const normalizeChatWorkspaceDock = normalizeChoice(CHAT_WORKSPACE_DOCKS, "right");

export function normalizeTextScale(value: unknown, fallback: TextScaleStop = 100): TextScaleStop {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  let best: TextScaleStop = TEXT_SCALE_STOPS[0];
  let bestDist = Math.abs(value - best);
  for (const stop of TEXT_SCALE_STOPS) {
    const dist = Math.abs(value - stop);
    if (dist < bestDist) {
      best = stop;
      bestDist = dist;
    }
  }
  return best;
}

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;
  chatPersistCommentary?: boolean;
  chatSendShortcut?: ChatSendShortcut;
  chatFollowUpMode?: ChatFollowUpMode; // Default handling for messages sent while a run is active
  catalogOpenTarget?: CatalogOpenTarget;
  realtimeTalkInputDeviceId?: string;
  realtimeTalkVideoDeviceId?: string;
  composerHoldToRecord?: boolean;
  // Camera intent is device-local, not per-agent or synced through config ui.prefs.
  talkCameraAutoEnable?: boolean;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  chatSplitLayout?: ChatSplitLayout;
  chatWorkspaceDock?: ChatWorkspaceDock; // Session workspace rail dock edge (default "right")
  boardSessionViews?: BoardSessionViews; // Last face and active dashboard tab per session
  navCollapsed: boolean; // Collapsible sidebar state
  navWidth: number; // Sidebar width when expanded (240–400px)
  sidebarEntries: string[]; // Ordered routes and pinned sessions below Home
  sidebarLiveActivity?: boolean; // Latest activity under running sidebar sessions (default true)
  pinnedAgentIds?: string[]; // Agents surfaced first in the agent-chip quick switcher
  textScale?: TextScaleStop; // Browser-local text scale percentage
  customTheme?: ImportedCustomTheme;
  locale?: string;
  lobsterPetVisits?: boolean; // Whether the sidebar lobster pet drops by (default true)
  lobsterPetSounds?: boolean; // Opt-in poke/pet chirps from the lobster (default false)
};

type LastActiveSessionHost = {
  settings: UiSettings;
  applySettings(next: UiSettings): void;
};

export function setLastActiveSessionKey(host: LastActiveSessionHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed || host.settings.lastActiveSessionKey === trimmed) {
    return;
  }
  host.applySettings({ ...host.settings, lastActiveSessionKey: trimmed });
}

function isViteDevPage(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src*="/@vite/client"]'));
}

function formatHostWithPort(hostname: string, port: string): string {
  const normalizedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${normalizedHost}:${port}`;
}

function deriveDefaultGatewayUrl(): { pageUrl: string; effectiveUrl: string } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const basePath = resolveControlUiBasePath(location.pathname);
  const pageUrl = `${proto}://${location.host}${basePath}`;
  if (!isViteDevPage()) {
    return { pageUrl, effectiveUrl: pageUrl };
  }
  const effectiveUrl = `${proto}://${formatHostWithPort(location.hostname, "18789")}`;
  return { pageUrl, effectiveUrl };
}

/**
 * Standalone documents are owned by the Gateway that served their URL. Do not
 * let the full app's persisted remote selection retarget a security decision.
 * Native auth and explicit URL overrides are applied after this default.
 */
export function resolvePageGatewaySettings(settings: UiSettings): UiSettings {
  const { effectiveUrl } = deriveDefaultGatewayUrl();
  if (
    normalizeGatewayTokenScope(settings.gatewayUrl) === normalizeGatewayTokenScope(effectiveUrl)
  ) {
    return settings;
  }
  const session = loadGatewaySessionSelection(effectiveUrl);
  return {
    ...settings,
    gatewayUrl: effectiveUrl,
    token: resolveGatewayTokenForUrlEdit(settings.gatewayUrl, effectiveUrl, settings.token),
    sessionKey: session.sessionKey,
    lastActiveSessionKey: session.lastActiveSessionKey,
  };
}

function getSessionStorage(): Storage | null {
  return getSafeSessionStorage();
}

type PersistedSettingsSource = {
  gatewayUrl: string;
  parsed: PersistedUiSettings;
};

function parsePersistedSettings(raw: string | null): PersistedUiSettings | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as PersistedUiSettings;
  } catch {
    return null;
  }
}

function settingsMatchGatewayTarget(parsed: PersistedUiSettings, targetUrl: string): boolean {
  const storedUrl = normalizeOptionalString(parsed.gatewayUrl);
  if (!storedUrl) {
    return false;
  }
  return normalizeGatewayTokenScope(storedUrl) === normalizeGatewayTokenScope(targetUrl);
}

function readSettingsForGateway(
  storage: Storage | null,
  targetUrl: string,
): PersistedSettingsSource | null {
  const scoped = parsePersistedSettings(storage?.getItem(settingsKeyForGateway(targetUrl)) ?? null);
  if (
    scoped &&
    (!normalizeOptionalString(scoped.gatewayUrl) || settingsMatchGatewayTarget(scoped, targetUrl))
  ) {
    return {
      gatewayUrl: normalizeOptionalString(scoped.gatewayUrl) ?? targetUrl,
      parsed: scoped,
    };
  }
  return null;
}

function tokenSessionKeyForGateway(gatewayUrl: string): string {
  return `${TOKEN_SESSION_KEY_PREFIX}${normalizeGatewayTokenScope(gatewayUrl)}`;
}

function resolveScopedSessionSelection(
  gatewayUrl: string,
  parsed: PersistedUiSettings,
  fallback: ScopedSessionSelection,
): ScopedSessionSelection {
  const scope = normalizeGatewayTokenScope(gatewayUrl);
  const scoped = parsed.sessionsByGateway?.[scope];
  const scopedSessionKey = normalizeOptionalString(scoped?.sessionKey);
  const scopedLastActiveSessionKey = normalizeOptionalString(scoped?.lastActiveSessionKey);
  if (scopedSessionKey && scopedLastActiveSessionKey) {
    return {
      sessionKey: scopedSessionKey,
      lastActiveSessionKey: scopedLastActiveSessionKey,
    };
  }

  const legacySessionKey = normalizeOptionalString(parsed.sessionKey) ?? fallback.sessionKey;
  const legacyLastActiveSessionKey =
    normalizeOptionalString(parsed.lastActiveSessionKey) ??
    legacySessionKey ??
    fallback.lastActiveSessionKey;

  return {
    sessionKey: legacySessionKey,
    lastActiveSessionKey: legacyLastActiveSessionKey,
  };
}

export function loadGatewaySessionSelection(gatewayUrl: string): ScopedSessionSelection {
  const fallback = { sessionKey: "main", lastActiveSessionKey: "main" };
  try {
    const storage = getSafeLocalStorage();
    const source = readSettingsForGateway(storage, gatewayUrl);
    return source ? resolveScopedSessionSelection(gatewayUrl, source.parsed, fallback) : fallback;
  } catch {
    return fallback;
  }
}

function loadSessionToken(gatewayUrl: string): string {
  try {
    const storage = getSessionStorage();
    if (!storage) {
      return "";
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const token = storage.getItem(tokenSessionKeyForGateway(gatewayUrl));
    return normalizeOptionalString(token) ?? "";
  } catch {
    return "";
  }
}

export function resolveGatewayTokenForUrlEdit(
  currentGatewayUrl: string,
  nextGatewayUrl: string,
  currentToken: string,
): string {
  if (
    normalizeGatewayTokenScope(currentGatewayUrl) === normalizeGatewayTokenScope(nextGatewayUrl)
  ) {
    return currentToken;
  }
  // Gateway tokens stay session-scoped across endpoint edits.
  // Durable settings may contain scrubbed legacy tokens, but must not restore them here.
  return loadSessionToken(nextGatewayUrl);
}

export function persistSessionToken(gatewayUrl: string, token: string) {
  try {
    const storage = getSessionStorage();
    if (!storage) {
      return;
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const key = tokenSessionKeyForGateway(gatewayUrl);
    const normalized = normalizeOptionalString(token) ?? "";
    if (normalized) {
      storage.setItem(key, normalized);
      return;
    }
    storage.removeItem(key);
  } catch {
    // best-effort
  }
}

// Last write that never reached localStorage (private mode, quota, security
// errors). Without it a setting picked on one page silently reverts when
// another page re-reads storage in the same tab.
let unpersistedSettings: UiSettings | null = null;

export function loadSettings(): UiSettings {
  const cached = unpersistedSettings;
  if (cached) {
    // Gateway auth stays session-scoped; re-derive it instead of caching it.
    return { ...cached, token: loadSessionToken(cached.gatewayUrl) };
  }
  const { pageUrl: pageDerivedUrl, effectiveUrl: defaultUrl } = deriveDefaultGatewayUrl();
  const storage = getSafeLocalStorage();

  const defaults: UiSettings = {
    gatewayUrl: defaultUrl,
    token: loadSessionToken(defaultUrl),
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "system",
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatPersistCommentary: true,
    chatSendShortcut: "enter",
    catalogOpenTarget: "viewer",
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: NAV_WIDTH_DEFAULT,
    sidebarEntries: [...DEFAULT_SIDEBAR_ENTRIES],
    sidebarLiveActivity: true,
    pinnedAgentIds: [],
    textScale: 100,
    composerHoldToRecord: true,
  };

  try {
    const selectedGatewayUrl = normalizeOptionalString(
      storage?.getItem(currentGatewaySelectionKeyForPage(pageDerivedUrl)),
    );
    const selected = selectedGatewayUrl
      ? readSettingsForGateway(storage, selectedGatewayUrl)
      : null;
    const defaultSource = readSettingsForGateway(storage, defaultUrl);
    const source = selected ?? defaultSource;
    if (!source) {
      return defaults;
    }
    const parsed = source.parsed;
    const parsedGatewayUrl = source.gatewayUrl;
    const gatewayUrl = parsedGatewayUrl === pageDerivedUrl ? defaultUrl : parsedGatewayUrl;
    const scopedSessionSelection = resolveScopedSessionSelection(gatewayUrl, parsed, defaults);
    const customTheme = parseImportedCustomTheme((parsed as { customTheme?: unknown }).customTheme);
    const { theme, mode } = parseThemeSelection(
      (parsed as { theme?: unknown }).theme,
      (parsed as { themeMode?: unknown }).themeMode,
    );
    const parsedRecord = parsed as unknown as Record<string, unknown>;
    const hasSidebarEntries = Object.hasOwn(parsedRecord, "sidebarEntries");
    // One-time read of the retired route-only shape; all writes use sidebarEntries.
    const migratedSidebarEntries = hasSidebarEntries
      ? null
      : Array.isArray(parsedRecord.sidebarPinnedRoutes)
        ? normalizeSidebarEntries(
            parsedRecord.sidebarPinnedRoutes.flatMap((value) =>
              typeof value === "string" && SIDEBAR_NAV_ROUTES.some((route) => route === value)
                ? [
                    serializeSidebarEntry({
                      type: "route",
                      route: value as (typeof SIDEBAR_NAV_ROUTES)[number],
                    }),
                  ]
                : [],
            ),
          )
        : null;
    const settings: UiSettings = {
      gatewayUrl,
      // Gateway auth is intentionally in-memory only; scrub any legacy persisted token on load.
      token: loadSessionToken(gatewayUrl),
      sessionKey: scopedSessionSelection.sessionKey,
      lastActiveSessionKey: scopedSessionSelection.lastActiveSessionKey,
      theme: theme === "custom" && !customTheme ? "claw" : theme,
      themeMode: mode,
      chatShowThinking:
        typeof parsed.chatShowThinking === "boolean"
          ? parsed.chatShowThinking
          : defaults.chatShowThinking,
      chatShowToolCalls:
        typeof parsed.chatShowToolCalls === "boolean"
          ? parsed.chatShowToolCalls
          : defaults.chatShowToolCalls,
      chatPersistCommentary:
        typeof parsed.chatPersistCommentary === "boolean"
          ? parsed.chatPersistCommentary
          : defaults.chatPersistCommentary,
      chatSendShortcut: normalizeChatSendShortcut(parsed.chatSendShortcut),
      chatFollowUpMode: normalizeChatFollowUpModeOverride(parsed.chatFollowUpMode),
      catalogOpenTarget: normalizeCatalogOpenTarget(parsed.catalogOpenTarget),
      realtimeTalkInputDeviceId: normalizeOptionalString(parsed.realtimeTalkInputDeviceId),
      realtimeTalkVideoDeviceId: normalizeOptionalString(parsed.realtimeTalkVideoDeviceId),
      composerHoldToRecord:
        typeof parsed.composerHoldToRecord === "boolean"
          ? parsed.composerHoldToRecord
          : defaults.composerHoldToRecord,
      talkCameraAutoEnable:
        typeof parsed.talkCameraAutoEnable === "boolean" ? parsed.talkCameraAutoEnable : undefined,
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      chatSplitLayout: normalizeChatSplitLayout(parsed.chatSplitLayout),
      chatWorkspaceDock: normalizeChatWorkspaceDock(parsed.chatWorkspaceDock),
      boardSessionViews: normalizeBoardSessionViews(parsed.boardSessionViews),
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navWidth:
        typeof parsed.navWidth === "number" &&
        parsed.navWidth >= NAV_WIDTH_MIN &&
        parsed.navWidth <= NAV_WIDTH_MAX
          ? parsed.navWidth
          : defaults.navWidth,
      sidebarEntries:
        normalizeSidebarEntries(parsedRecord.sidebarEntries) ??
        migratedSidebarEntries ??
        defaults.sidebarEntries,
      sidebarLiveActivity:
        typeof parsed.sidebarLiveActivity === "boolean"
          ? parsed.sidebarLiveActivity
          : defaults.sidebarLiveActivity,
      pinnedAgentIds: normalizePinnedAgentIds(parsed.pinnedAgentIds),
      textScale: normalizeTextScale(parsed.textScale, defaults.textScale),
      customTheme: customTheme ?? undefined,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
      ...(parsed.lobsterPetVisits === false ? { lobsterPetVisits: false } : {}),
      ...(parsed.lobsterPetSounds === true ? { lobsterPetSounds: true } : {}),
    };
    // Scoped blobs from builds that persisted tokens durably get rewritten once
    // so the plaintext token leaves localStorage.
    if ("token" in parsed || migratedSidebarEntries !== null) {
      persistSettings(settings, { selectGateway: true });
    }
    return settings;
  } catch {
    return defaults;
  }
}

export function saveSettings(next: UiSettings) {
  persistSettings(next);
}

// Single change seam over the one write channel every settings mutation uses;
// the server-prefs sync (app/server-prefs.ts) listens here to write synced
// prefs through to config ui.prefs without each call site knowing about it.
type SettingsChangeListener = (previous: UiSettings, next: UiSettings) => void;
let settingsChangeListener: SettingsChangeListener | null = null;

export function setSettingsChangeListener(listener: SettingsChangeListener | null) {
  settingsChangeListener = listener;
}

export function patchSettings(
  patch: Partial<UiSettings>,
  options: { selectGateway?: boolean } = {},
): UiSettings {
  const previous = loadSettings();
  const next = { ...previous, ...patch };
  persistSettings(next, {
    selectGateway: options.selectGateway ?? patch.gatewayUrl !== undefined,
  });
  settingsChangeListener?.(previous, next);
  return next;
}

export function loadLocalUserIdentity(): LocalUserIdentity {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_USER_IDENTITY_KEY);
    if (!raw) {
      return normalizeLocalUserIdentity();
    }
    return normalizeLocalUserIdentity(JSON.parse(raw) as Partial<LocalUserIdentity>);
  } catch {
    return normalizeLocalUserIdentity();
  }
}

function persistSettings(next: UiSettings, options: { selectGateway?: boolean } = {}) {
  persistSessionToken(next.gatewayUrl, next.token);
  const storage = getSafeLocalStorage();
  const scope = normalizeGatewayTokenScope(next.gatewayUrl);
  const scopedKey = settingsKeyForGateway(next.gatewayUrl);
  const chatFollowUpMode = normalizeChatFollowUpModeOverride(next.chatFollowUpMode);
  let existingSessionsByGateway: Record<string, ScopedSessionSelection> = {};
  try {
    const source = readSettingsForGateway(storage, next.gatewayUrl);
    if (source) {
      const parsed = source.parsed;
      if (parsed.sessionsByGateway && typeof parsed.sessionsByGateway === "object") {
        existingSessionsByGateway = parsed.sessionsByGateway;
      }
    }
  } catch {
    // best-effort
  }
  const sessionsByGateway = Object.fromEntries(
    [
      ...Object.entries(existingSessionsByGateway).filter(([key]) => key !== scope),
      [
        scope,
        {
          sessionKey: next.sessionKey,
          lastActiveSessionKey: next.lastActiveSessionKey,
        },
      ],
    ].slice(-MAX_SCOPED_SESSION_ENTRIES),
  );
  const persisted: PersistedUiSettings = {
    gatewayUrl: next.gatewayUrl,
    theme: next.theme,
    themeMode: next.themeMode,
    chatShowThinking: next.chatShowThinking,
    chatShowToolCalls: next.chatShowToolCalls,
    chatPersistCommentary: next.chatPersistCommentary ?? true,
    ...(normalizeChatSendShortcut(next.chatSendShortcut) === "modifier-enter"
      ? { chatSendShortcut: "modifier-enter" as const }
      : {}),
    ...(chatFollowUpMode ? { chatFollowUpMode } : {}),
    ...(normalizeCatalogOpenTarget(next.catalogOpenTarget) === "terminal"
      ? { catalogOpenTarget: "terminal" as const }
      : {}),
    ...(normalizeOptionalString(next.realtimeTalkInputDeviceId)
      ? { realtimeTalkInputDeviceId: normalizeOptionalString(next.realtimeTalkInputDeviceId) }
      : {}),
    ...(normalizeOptionalString(next.realtimeTalkVideoDeviceId)
      ? { realtimeTalkVideoDeviceId: normalizeOptionalString(next.realtimeTalkVideoDeviceId) }
      : {}),
    ...(next.composerHoldToRecord === false ? { composerHoldToRecord: false } : {}),
    ...(typeof next.talkCameraAutoEnable === "boolean"
      ? { talkCameraAutoEnable: next.talkCameraAutoEnable }
      : {}),
    splitRatio: next.splitRatio,
    ...(next.chatSplitLayout ? { chatSplitLayout: next.chatSplitLayout } : {}),
    // Right dock is the default; only the opt-in bottom dock persists.
    ...(next.chatWorkspaceDock === "bottom" ? { chatWorkspaceDock: "bottom" as const } : {}),
    ...(next.boardSessionViews && Object.keys(next.boardSessionViews).length > 0
      ? { boardSessionViews: normalizeBoardSessionViews(next.boardSessionViews) }
      : {}),
    navCollapsed: next.navCollapsed,
    navWidth: next.navWidth,
    sidebarEntries: next.sidebarEntries,
    ...(next.sidebarLiveActivity === false ? { sidebarLiveActivity: false } : {}),
    // Empty pin list is the default; only real pins persist.
    ...(next.pinnedAgentIds && next.pinnedAgentIds.length > 0
      ? { pinnedAgentIds: next.pinnedAgentIds }
      : {}),
    textScale: normalizeTextScale(next.textScale),
    ...(next.customTheme ? { customTheme: next.customTheme } : {}),
    sessionsByGateway,
    ...(next.locale ? { locale: next.locale } : {}),
    // Visits default on; only an explicit opt-out persists. Sounds default
    // off; only an explicit opt-in persists.
    ...(next.lobsterPetVisits === false ? { lobsterPetVisits: false } : {}),
    ...(next.lobsterPetSounds === true ? { lobsterPetSounds: true } : {}),
  };
  const serialized = JSON.stringify(persisted);
  unpersistedSettings = next;
  try {
    const { pageUrl } = deriveDefaultGatewayUrl();
    const selectionKey = currentGatewaySelectionKeyForPage(pageUrl);
    storage?.setItem(scopedKey, serialized);
    if (options.selectGateway || storage?.getItem(selectionKey) == null) {
      storage?.setItem(selectionKey, next.gatewayUrl);
    }
    storage?.removeItem(LEGACY_SETTINGS_KEY);
    if (storage) {
      unpersistedSettings = null;
    }
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory settings and visual updates from being applied;
    // unpersistedSettings keeps this tab consistent until storage recovers
  }
}
