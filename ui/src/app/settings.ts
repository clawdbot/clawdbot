import { gatewayCredentialScope, gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { safeParseJson } from "@openclaw/normalization-core";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  DEFAULT_SIDEBAR_ENTRIES,
  isPersistedSidebarRoute,
  normalizeSidebarEntries,
  serializeSidebarEntry,
} from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import { normalizeBoardSessionViews, type BoardSessionViews } from "../lib/board/settings.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";
import {
  normalizeSidebarSessionActivePanels,
  normalizeSidebarSessionLayouts,
  type SidebarSessionActivePanels,
  type SidebarSessionLayouts,
} from "../pages/chat/sidebar-layout-persistence.ts";
import { normalizeChatSplitLayout } from "../pages/chat/split-layout-persistence.ts";
import type { ChatSplitLayout } from "../pages/chat/split-layout-types.ts";
import { resolveControlUiPaths } from "./browser.ts";
import { parseImportedCustomTheme, type ImportedCustomTheme } from "./custom-theme.ts";
import { parseThemeSelection, type ThemeMode, type ThemeName } from "./theme.ts";
import { normalizeTypefaceOverride, type TypefaceId } from "./typography.ts";
import { normalizeLocalUserIdentity, type LocalUserIdentity } from "./user-identity.ts";

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
  return `${SETTINGS_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

function currentGatewaySelectionKeyForPage(pageUrl: string): string {
  return `${CURRENT_GATEWAY_SELECTION_KEY_PREFIX}${gatewayOriginScope(pageUrl)}`;
}

type ScopedSessionSelection = {
  sessionKey: string;
  lastActiveSessionKey: string;
  selectedAgentId?: string;
};

type PersistedUiSettings = Omit<
  UiSettings,
  "token" | "sessionKey" | "lastActiveSessionKey" | "selectedAgentId" | "navCollapsed"
> & {
  token?: never;
  sessionKey?: string;
  lastActiveSessionKey?: string;
  sessionsByGateway?: Record<string, ScopedSessionSelection>;
};

export const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;
export type TextScaleStop = (typeof TEXT_SCALE_STOPS)[number];

const CSS_WIDTH_KEYWORDS = new Set(["none", "min-content", "max-content"]);
const CSS_WIDTH_FUNCTIONS = new Set(["calc", "clamp", "fit-content", "max", "min"]);
const CSS_WIDTH_UNITS = new Set(["ch", "em", "rem", "vh", "vmax", "vmin", "vw", "px"]);
const CSS_WIDTH_ALLOWED_CHARS = /^[0-9A-Za-z.%+\-*/(),\s]+$/;
const CSS_WIDTH_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9-]*/g;
const CSS_WIDTH_SIMPLE_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax|%)$/i;
const CSS_WIDTH_MAX_LENGTH = 96;

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function hasAllowedWidthIdentifiers(value: string): boolean {
  for (const match of value.matchAll(CSS_WIDTH_IDENTIFIER_RE)) {
    const identifier = match[0].toLowerCase();
    if (
      !CSS_WIDTH_FUNCTIONS.has(identifier) &&
      !CSS_WIDTH_KEYWORDS.has(identifier) &&
      !CSS_WIDTH_UNITS.has(identifier)
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeChatMessageMaxWidth(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length > CSS_WIDTH_MAX_LENGTH) {
    return undefined;
  }
  if (CSS_WIDTH_KEYWORDS.has(normalized.toLowerCase()) || CSS_WIDTH_SIMPLE_RE.test(normalized)) {
    return normalized;
  }
  if (
    !CSS_WIDTH_ALLOWED_CHARS.test(normalized) ||
    !hasBalancedParentheses(normalized) ||
    !hasAllowedWidthIdentifiers(normalized)
  ) {
    return undefined;
  }
  return /^(?:calc|clamp|fit-content|max|min)\(.+\)$/i.test(normalized) ? normalized : undefined;
}

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

export function normalizeAccentColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

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

export const UI_APPEARANCE_DEFAULTS = {
  theme: "claw",
  themeMode: "system",
  textScale: 100,
  sidebarLiveActivity: true,
  chatMessageMaxWidth: "48rem",
  chatCollapseTaskProgress: false,
  chatSendShortcut: "enter",
  catalogOpenTarget: "viewer",
  composerHoldToRecord: true,
  lobsterPetVisits: true,
  lobsterPetSounds: false,
  sessionDeleteConfirm: true,
} as const;

export type UiSettings = {
  gatewayUrl: string;
  token: string;
  sessionKey: string;
  lastActiveSessionKey: string;
  selectedAgentId?: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  accent?: string;
  // Browser typeface overrides; undefined = theme default.
  fontUi?: TypefaceId;
  fontChat?: TypefaceId;
  chatShowThinking: boolean;
  chatShowToolCalls: boolean;
  chatPersistCommentary?: boolean;
  // Browser-local presentation preference; false preserves active-card auto-expand.
  chatCollapseTaskProgress?: boolean;
  chatSendShortcut?: ChatSendShortcut;
  chatFollowUpMode?: ChatFollowUpMode; // Default handling for messages sent while a run is active
  catalogOpenTarget?: CatalogOpenTarget;
  realtimeTalkInputDeviceId?: string;
  realtimeTalkVideoDeviceId?: string;
  composerHoldToRecord?: boolean;
  // Camera intent is device-local, not per-agent or synced through config ui.prefs.
  talkCameraAutoEnable?: boolean;
  chatSplitLayout?: ChatSplitLayout;
  chatWorkspaceDock?: ChatWorkspaceDock; // Session workspace rail dock edge (default "right")
  boardSessionViews?: BoardSessionViews; // Per-device active dashboard tab and dock state
  sidebarSessionLayouts?: SidebarSessionLayouts; // Sidebar columns and widths per session
  sidebarSessionActivePanels?: SidebarSessionActivePanels; // Collapsed active panel per session
  navCollapsed: boolean; // Collapsible sidebar state
  navWidth: number; // Sidebar width when expanded (240–400px)
  sidebarEntries: string[]; // Ordered routes, Workboard boards, and pinned sessions below Home
  sidebarLiveActivity?: boolean; // Latest activity under running sidebar sessions (default true)
  chatMessageMaxWidth?: string; // Browser-local centered chat transcript max width
  showAdvancedSettings?: boolean; // Expand advanced schema settings (default false)
  pinnedAgentIds?: string[]; // Agents surfaced first in the agent-chip quick switcher
  textScale?: TextScaleStop; // Browser-local text scale percentage
  customTheme?: ImportedCustomTheme;
  locale?: string;
  lobsterPetVisits?: boolean; // Whether the sidebar lobster pet drops by (default true)
  lobsterPetSounds?: boolean; // Opt-in poke/pet chirps from the lobster (default false)
  // Confirm before deleting sessions (default true). Device-local on purpose:
  // opting out on one browser must not lower the bar on the operator's others,
  // so this stays out of the synced ui.prefs set in server-prefs-state.ts.
  sessionDeleteConfirm?: boolean;
  // Device-local opt-in: route eligible external links into the Gateway browser panel.
  openLinksInControlUiBrowser?: boolean;
};

type LastActiveSessionHost = {
  settings: Pick<UiSettings, "lastActiveSessionKey">;
  applySettings(patch: Partial<UiSettings>): void;
};

export function setLastActiveSessionKey(host: LastActiveSessionHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed || host.settings.lastActiveSessionKey === trimmed) {
    return;
  }
  host.applySettings({ lastActiveSessionKey: trimmed });
}

function isViteDevPage(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src*="/@vite/client"]'));
}

function formatHostWithPort(hostname: string, port: string): string {
  // location.hostname already carries brackets for IPv6 literals; wrapping
  // again would produce an undialable ws://[[::1]]:port default.
  const needsBrackets = hostname.includes(":") && !hostname.startsWith("[");
  const normalizedHost = needsBrackets ? `[${hostname}]` : hostname;
  return `${normalizedHost}:${port}`;
}

function deriveDefaultGatewayUrl(): { pageUrl: string; effectiveUrl: string } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const basePath = resolveControlUiPaths(location.pathname)[0];
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
  if (gatewayOriginScope(settings.gatewayUrl) === gatewayOriginScope(effectiveUrl)) {
    return settings;
  }
  const session = loadGatewaySessionSelection(effectiveUrl);
  return {
    ...settings,
    gatewayUrl: effectiveUrl,
    token: resolveGatewayCredentialsForUrlEdit(settings.gatewayUrl, effectiveUrl, {
      token: settings.token,
      password: "",
    }).token,
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
  return (safeParseJson(raw) as PersistedUiSettings | undefined) ?? null;
}

function settingsMatchGatewayTarget(parsed: PersistedUiSettings, targetUrl: string): boolean {
  const storedUrl = normalizeOptionalString(parsed.gatewayUrl);
  if (!storedUrl) {
    return false;
  }
  return gatewayOriginScope(storedUrl) === gatewayOriginScope(targetUrl);
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
  return `${TOKEN_SESSION_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

function resolveScopedSessionSelection(
  gatewayUrl: string,
  parsed: PersistedUiSettings,
  fallback: ScopedSessionSelection,
): ScopedSessionSelection {
  const scope = gatewayOriginScope(gatewayUrl);
  const scoped = parsed.sessionsByGateway?.[scope];
  const scopedSessionKey = normalizeOptionalString(scoped?.sessionKey);
  const scopedLastActiveSessionKey = normalizeOptionalString(scoped?.lastActiveSessionKey);
  const scopedSelectedAgentId = normalizeOptionalString(scoped?.selectedAgentId);
  if (scopedSessionKey && scopedLastActiveSessionKey) {
    return {
      sessionKey: scopedSessionKey,
      lastActiveSessionKey: scopedLastActiveSessionKey,
      ...(scopedSelectedAgentId
        ? { selectedAgentId: normalizeAgentId(scopedSelectedAgentId) }
        : {}),
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

export function resolveGatewayCredentialsForUrlEdit(
  currentGatewayUrl: string,
  nextGatewayUrl: string,
  credentials: { token: string; password: string },
): { token: string; password: string } {
  const sameTokenScope =
    gatewayOriginScope(currentGatewayUrl) === gatewayOriginScope(nextGatewayUrl);
  const sameCredentialScope =
    gatewayCredentialScope(currentGatewayUrl) === gatewayCredentialScope(nextGatewayUrl);
  return {
    // Gateway tokens stay session-scoped across endpoint edits. Durable settings
    // may contain scrubbed legacy tokens, but must not restore them here.
    token: sameTokenScope ? credentials.token : loadSessionToken(nextGatewayUrl),
    password: sameCredentialScope ? credentials.password : "",
  };
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
    theme: UI_APPEARANCE_DEFAULTS.theme,
    themeMode: UI_APPEARANCE_DEFAULTS.themeMode,
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatPersistCommentary: true,
    chatCollapseTaskProgress: UI_APPEARANCE_DEFAULTS.chatCollapseTaskProgress,
    chatSendShortcut: UI_APPEARANCE_DEFAULTS.chatSendShortcut,
    catalogOpenTarget: UI_APPEARANCE_DEFAULTS.catalogOpenTarget,
    navCollapsed: false,
    navWidth: NAV_WIDTH_DEFAULT,
    sidebarEntries: [...DEFAULT_SIDEBAR_ENTRIES],
    sidebarLiveActivity: UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
    showAdvancedSettings: false,
    pinnedAgentIds: [],
    composerHoldToRecord: UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
  };

  try {
    const selectedGatewayUrl = normalizeOptionalString(
      storage?.getItem(currentGatewaySelectionKeyForPage(pageDerivedUrl)),
    );
    const source =
      (selectedGatewayUrl ? readSettingsForGateway(storage, selectedGatewayUrl) : null) ??
      readSettingsForGateway(storage, defaultUrl);
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
    const parsedRecord = asOptionalRecord(parsed) ?? {};
    const hasSidebarEntries = Object.hasOwn(parsedRecord, "sidebarEntries");
    // One-time read of the retired route-only shape; all writes use sidebarEntries.
    const migratedSidebarEntries = hasSidebarEntries
      ? null
      : Array.isArray(parsedRecord.sidebarPinnedRoutes)
        ? normalizeSidebarEntries(
            parsedRecord.sidebarPinnedRoutes.flatMap((value) =>
              isPersistedSidebarRoute(value)
                ? [
                    serializeSidebarEntry({
                      type: "route",
                      route: value,
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
      selectedAgentId: scopedSessionSelection.selectedAgentId,
      theme: theme === "custom" && !customTheme ? "claw" : theme,
      themeMode: mode,
      accent: normalizeAccentColor(parsed.accent),
      fontUi: normalizeTypefaceOverride(parsed.fontUi),
      fontChat: normalizeTypefaceOverride(parsed.fontChat),
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
      chatCollapseTaskProgress:
        typeof parsed.chatCollapseTaskProgress === "boolean"
          ? parsed.chatCollapseTaskProgress
          : defaults.chatCollapseTaskProgress,
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
      chatSplitLayout: normalizeChatSplitLayout(parsed.chatSplitLayout),
      chatWorkspaceDock: normalizeChatWorkspaceDock(parsed.chatWorkspaceDock),
      boardSessionViews: normalizeBoardSessionViews(parsed.boardSessionViews),
      sidebarSessionLayouts: normalizeSidebarSessionLayouts(parsed.sidebarSessionLayouts),
      sidebarSessionActivePanels: normalizeSidebarSessionActivePanels(
        parsed.sidebarSessionActivePanels,
      ),
      navCollapsed: defaults.navCollapsed,
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
      chatMessageMaxWidth: normalizeChatMessageMaxWidth(parsed.chatMessageMaxWidth),
      showAdvancedSettings:
        typeof parsed.showAdvancedSettings === "boolean"
          ? parsed.showAdvancedSettings
          : defaults.showAdvancedSettings,
      pinnedAgentIds: normalizeUniqueTrimmedStringList(parsed.pinnedAgentIds),
      textScale:
        typeof parsed.textScale === "number" &&
        normalizeTextScale(parsed.textScale) !== UI_APPEARANCE_DEFAULTS.textScale
          ? normalizeTextScale(parsed.textScale)
          : undefined,
      customTheme: customTheme ?? undefined,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
      ...(parsed.lobsterPetVisits === false ? { lobsterPetVisits: false } : {}),
      ...(parsed.lobsterPetSounds === true ? { lobsterPetSounds: true } : {}),
      ...(parsed.sessionDeleteConfirm === false ? { sessionDeleteConfirm: false } : {}),
      ...(parsed.openLinksInControlUiBrowser === true ? { openLinksInControlUiBrowser: true } : {}),
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
  const scope = gatewayOriginScope(next.gatewayUrl);
  const scopedKey = settingsKeyForGateway(next.gatewayUrl);
  const accent = normalizeAccentColor(next.accent);
  const fontUi = normalizeTypefaceOverride(next.fontUi);
  const fontChat = normalizeTypefaceOverride(next.fontChat);
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
          ...(normalizeOptionalString(next.selectedAgentId)
            ? { selectedAgentId: normalizeAgentId(next.selectedAgentId) }
            : {}),
        },
      ],
    ].slice(-MAX_SCOPED_SESSION_ENTRIES),
  );
  const persisted: PersistedUiSettings = {
    gatewayUrl: next.gatewayUrl,
    theme: next.theme,
    themeMode: next.themeMode,
    ...(accent ? { accent } : {}),
    ...(fontUi ? { fontUi } : {}),
    ...(fontChat ? { fontChat } : {}),
    chatShowThinking: next.chatShowThinking,
    chatShowToolCalls: next.chatShowToolCalls,
    chatPersistCommentary: next.chatPersistCommentary ?? true,
    ...(next.chatCollapseTaskProgress === true ? { chatCollapseTaskProgress: true } : {}),
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
    ...(next.chatSplitLayout ? { chatSplitLayout: next.chatSplitLayout } : {}),
    // Right dock is the default; only the opt-in bottom dock persists.
    ...(next.chatWorkspaceDock === "bottom" ? { chatWorkspaceDock: "bottom" as const } : {}),
    ...(next.boardSessionViews && Object.keys(next.boardSessionViews).length > 0
      ? { boardSessionViews: normalizeBoardSessionViews(next.boardSessionViews) }
      : {}),
    ...(next.sidebarSessionLayouts && Object.keys(next.sidebarSessionLayouts).length > 0
      ? { sidebarSessionLayouts: normalizeSidebarSessionLayouts(next.sidebarSessionLayouts) }
      : {}),
    ...(next.sidebarSessionActivePanels && Object.keys(next.sidebarSessionActivePanels).length > 0
      ? {
          sidebarSessionActivePanels: normalizeSidebarSessionActivePanels(
            next.sidebarSessionActivePanels,
          ),
        }
      : {}),
    navWidth: next.navWidth, // Persist size, not visibility: shared localStorage leaks across tabs.
    sidebarEntries: next.sidebarEntries,
    ...(next.sidebarLiveActivity === false ? { sidebarLiveActivity: false } : {}),
    ...(normalizeChatMessageMaxWidth(next.chatMessageMaxWidth)
      ? { chatMessageMaxWidth: normalizeChatMessageMaxWidth(next.chatMessageMaxWidth) }
      : {}),
    ...(next.showAdvancedSettings === true ? { showAdvancedSettings: true } : {}),
    // Empty pin list is the default; only real pins persist.
    ...(next.pinnedAgentIds && next.pinnedAgentIds.length > 0
      ? { pinnedAgentIds: next.pinnedAgentIds }
      : {}),
    ...(next.textScale !== undefined ? { textScale: normalizeTextScale(next.textScale) } : {}),
    ...(next.customTheme ? { customTheme: next.customTheme } : {}),
    sessionsByGateway,
    ...(next.locale ? { locale: next.locale } : {}),
    // Visits default on; only an explicit opt-out persists. Sounds default
    // off; only an explicit opt-in persists.
    ...(next.lobsterPetVisits === false ? { lobsterPetVisits: false } : {}),
    ...(next.lobsterPetSounds === true ? { lobsterPetSounds: true } : {}),
    // Only the opted-out value is persisted; absence means the safe default.
    ...(next.sessionDeleteConfirm === false ? { sessionDeleteConfirm: false } : {}),
    // External links keep host behavior unless the operator explicitly opts in.
    ...(next.openLinksInControlUiBrowser === true ? { openLinksInControlUiBrowser: true } : {}),
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
