// Control UI module implements storage behavior.
const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const LEGACY_SETTINGS_KEY = "openclaw.control.settings.v1";
export const NAV_WIDTH_MIN = 240;
export const NAV_WIDTH_MAX = 400;
export const NAV_WIDTH_DEFAULT = 258;
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
  DEFAULT_SIDEBAR_PINNED_ROUTES,
  normalizeSidebarPinnedRoutes,
  type SidebarNavRoute,
} from "../app-navigation.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import { normalizeOptionalString } from "../lib/string-coerce.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";
import { normalizeChatSplitLayout, type ChatSplitLayout } from "../pages/chat/split-layout.ts";
import { resolveControlUiBasePath } from "./browser.ts";
import { parseImportedCustomTheme, type ImportedCustomTheme } from "./custom-theme.ts";
import { normalizeGatewayTokenScope } from "./gateway-scope.ts";
import { parseThemeSelection, type ThemeMode, type ThemeName } from "./theme.ts";
import { normalizeLocalUserIdentity, type LocalUserIdentity } from "./user-identity.ts";

export const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;
export type TextScaleStop = (typeof TEXT_SCALE_STOPS)[number];

const CHAT_AUTO_SCROLL_MODES = ["always", "near-bottom", "off"] as const;
export type ChatAutoScrollMode = (typeof CHAT_AUTO_SCROLL_MODES)[number];

export function normalizeChatAutoScrollMode(value: unknown): ChatAutoScrollMode {
  return CHAT_AUTO_SCROLL_MODES.includes(value as ChatAutoScrollMode)
    ? (value as ChatAutoScrollMode)
    : "near-bottom";
}

const CHAT_SEND_SHORTCUTS = ["enter", "modifier-enter"] as const;
export type ChatSendShortcut = (typeof CHAT_SEND_SHORTCUTS)[number];

export function normalizeChatSendShortcut(value: unknown): ChatSendShortcut {
  return CHAT_SEND_SHORTCUTS.includes(value as ChatSendShortcut)
    ? (value as ChatSendShortcut)
    : "enter";
}

const CHAT_WORKSPACE_DOCKS = ["right", "bottom"] as const;
export type ChatWorkspaceDock = (typeof CHAT_WORKSPACE_DOCKS)[number];

export function normalizeChatWorkspaceDock(value: unknown): ChatWorkspaceDock {
  return CHAT_WORKSPACE_DOCKS.includes(value as ChatWorkspaceDock)
    ? (value as ChatWorkspaceDock)
    : "right";
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
  chatAutoScroll?: ChatAutoScrollMode;
  chatSendShortcut?: ChatSendShortcut;
  realtimeTalkInputDeviceId?: string;
  splitRatio: number; // Sidebar split ratio (0.4 to 0.7, default 0.6)
  chatSplitLayout?: ChatSplitLayout;
  chatWorkspaceDock?: ChatWorkspaceDock; // Session workspace rail dock edge (default "right")
  navCollapsed: boolean; // Collapsible sidebar state
  navWidth: number; // Sidebar width when expanded (240–400px)
  sidebarPinnedRoutes: SidebarNavRoute[]; // Nav routes shown above the "More" section
  sidebarMoreExpanded: boolean; // Whether the sidebar "More" section is expanded
  textScale?: TextScaleStop; // Browser-local text scale percentage
  customTheme?: ImportedCustomTheme;
  locale?: string;
  lobsterPetVisits?: boolean; // Whether the sidebar lobster pet drops by (default true)
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

type ApplicationStartupLocation = {
  pathname: string;
  search: string;
  hash: string;
};

type NativeControlAuth = {
  gatewayUrl?: string | null;
  token?: string | null;
  password?: string | null;
};

type ApplicationStartupSettings = {
  settings: UiSettings;
  password: string | null;
  pendingGatewayUrl: string | null;
  pendingGatewayToken: string | null;
  pendingBootstrapToken: string | null;
  queryTokenUsed: boolean;
  location: ApplicationStartupLocation;
  changed: boolean;
};

declare global {
  interface Window {
    __OPENCLAW_NATIVE_CONTROL_AUTH__?: NativeControlAuth;
  }
}

export function resolveApplicationStartupSettings(
  initialSettings: UiSettings,
  location: ApplicationStartupLocation,
): ApplicationStartupSettings {
  let settings = initialSettings;
  let changed = false;
  let password: string | null = null;
  let pendingGatewayUrl: string | null = null;
  let pendingGatewayToken: string | null = null;
  let pendingBootstrapToken: string | null = null;
  let queryTokenUsed = false;

  const updateSettings = (patch: Partial<UiSettings>) => {
    const entries = Object.entries(patch) as Array<
      [keyof UiSettings, UiSettings[keyof UiSettings]]
    >;
    if (entries.every(([key, value]) => settings[key] === value)) {
      return;
    }
    settings = { ...settings, ...patch };
    changed = true;
  };

  const nativeAuth =
    typeof window === "undefined" ? undefined : window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
  if (nativeAuth) {
    try {
      delete window["__OPENCLAW_NATIVE_CONTROL_AUTH__"];
    } catch {
      window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = undefined;
    }

    const gatewayUrl = normalizeOptionalString(nativeAuth.gatewayUrl);
    const token = normalizeOptionalString(nativeAuth.token);
    const nativePassword = normalizeOptionalString(nativeAuth.password);
    updateSettings({
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(token ? { token } : {}),
    });
    if (nativePassword) {
      password = nativePassword;
    }
  }

  if (!location.search && !location.hash) {
    return {
      settings,
      password,
      pendingGatewayUrl,
      pendingGatewayToken,
      pendingBootstrapToken,
      queryTokenUsed,
      location,
      changed,
    };
  }

  const url = new URL(
    `${location.pathname}${location.search}${location.hash}`,
    "http://openclaw.local",
  );
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const nextGatewayUrl = normalizeOptionalString(gatewayUrlRaw) ?? "";
  const gatewayUrlChanged = Boolean(nextGatewayUrl && nextGatewayUrl !== settings.gatewayUrl);
  const queryToken = params.get("token");
  const hashToken = hashParams.get("token");
  const hasTokenParam = hashToken != null || queryToken != null;
  const token = normalizeOptionalString(hashToken ?? queryToken);
  const hasBootstrapTokenParam = hashParams.has("bootstrapToken");
  const bootstrapToken = normalizeOptionalString(hashParams.get("bootstrapToken"));
  const session = normalizeOptionalString(params.get("session") ?? hashParams.get("session"));
  const shouldResetSessionForToken = Boolean(token && !session && !gatewayUrlChanged);
  let shouldCleanUrl = false;

  if (params.has("token")) {
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (hasTokenParam) {
    if (queryToken != null) {
      queryTokenUsed = true;
      console.warn(
        "[openclaw] Auth token passed as query parameter (?token=). Use URL fragment instead: #token=<token>. Query parameters may appear in server logs.",
      );
    }
    if (token && gatewayUrlChanged) {
      pendingGatewayToken = token;
    } else if (token) {
      updateSettings({ token });
    }
    hashParams.delete("token");
    shouldCleanUrl = true;
  }

  if (hasBootstrapTokenParam) {
    pendingBootstrapToken = bootstrapToken ?? null;
    hashParams.delete("bootstrapToken");
    shouldCleanUrl = true;
  }

  if (shouldResetSessionForToken) {
    updateSettings({
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  }

  if (params.has("password") || hashParams.has("password")) {
    params.delete("password");
    hashParams.delete("password");
    shouldCleanUrl = true;
  }

  if (session) {
    updateSettings({
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }

  if (gatewayUrlRaw != null) {
    pendingGatewayUrl = gatewayUrlChanged ? nextGatewayUrl : null;
    if (!gatewayUrlChanged) {
      pendingGatewayToken = null;
    } else if (pendingBootstrapToken) {
      pendingGatewayToken = null;
    }
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (shouldCleanUrl) {
    url.search = params.toString();
    const nextHash = hashParams.toString();
    url.hash = nextHash ? `#${nextHash}` : "";
  }

  return {
    settings,
    password,
    pendingGatewayUrl,
    pendingGatewayToken,
    pendingBootstrapToken,
    queryTokenUsed,
    location: shouldCleanUrl
      ? {
          pathname: url.pathname,
          search: url.search,
          hash: url.hash,
        }
      : location,
    changed,
  };
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

function getSessionStorage(): Storage | null {
  return getSafeSessionStorage();
}

type PersistedSettingsSource = {
  gatewayUrl: string;
  legacy: boolean;
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

function settingsMatchGatewayTarget(
  parsed: PersistedUiSettings,
  targetUrl: string,
  aliases: readonly string[] = [],
): boolean {
  const storedUrl = normalizeOptionalString(parsed.gatewayUrl);
  if (!storedUrl) {
    return false;
  }
  const storedScope = normalizeGatewayTokenScope(storedUrl);
  return [targetUrl, ...aliases].some(
    (candidate) => normalizeGatewayTokenScope(candidate) === storedScope,
  );
}

function isClaimableLegacyGateway(storedUrl: string | undefined, pageUrl: string): boolean {
  if (!storedUrl) {
    return false;
  }
  try {
    const stored = new URL(normalizeGatewayTokenScope(storedUrl));
    const page = new URL(normalizeGatewayTokenScope(pageUrl));
    return stored.host !== page.host || page.pathname === "/";
  } catch {
    return false;
  }
}

function readSettingsForGateway(
  storage: Storage | null,
  targetUrl: string,
  options: {
    includeLegacy?: boolean;
    legacyAliases?: readonly string[];
    remoteLegacyPageUrl?: string;
  } = {},
): PersistedSettingsSource | null {
  const scoped = parsePersistedSettings(storage?.getItem(settingsKeyForGateway(targetUrl)) ?? null);
  if (
    scoped &&
    (!normalizeOptionalString(scoped.gatewayUrl) || settingsMatchGatewayTarget(scoped, targetUrl))
  ) {
    return {
      gatewayUrl: normalizeOptionalString(scoped.gatewayUrl) ?? targetUrl,
      legacy: false,
      parsed: scoped,
    };
  }
  if (!options.includeLegacy) {
    return null;
  }
  for (const key of [`${SETTINGS_KEY_PREFIX}default`, LEGACY_SETTINGS_KEY]) {
    const parsed = parsePersistedSettings(storage?.getItem(key) ?? null);
    if (!parsed) {
      continue;
    }
    const storedUrl = normalizeOptionalString(parsed.gatewayUrl);
    const matchesTarget = settingsMatchGatewayTarget(parsed, targetUrl, options.legacyAliases);
    const isRemote = options.remoteLegacyPageUrl
      ? isClaimableLegacyGateway(storedUrl, options.remoteLegacyPageUrl)
      : false;
    if (matchesTarget || isRemote) {
      return {
        gatewayUrl: storedUrl ?? targetUrl,
        legacy: true,
        parsed,
      };
    }
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
    const source = readSettingsForGateway(storage, gatewayUrl, { includeLegacy: true });
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

function persistSessionToken(gatewayUrl: string, token: string) {
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

export function loadSettings(): UiSettings {
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
    chatPersistCommentary: false,
    chatAutoScroll: "near-bottom",
    chatSendShortcut: "enter",
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: NAV_WIDTH_DEFAULT,
    sidebarPinnedRoutes: [...DEFAULT_SIDEBAR_PINNED_ROUTES],
    sidebarMoreExpanded: false,
    textScale: 100,
  };

  try {
    const selectedGatewayUrl = normalizeOptionalString(
      storage?.getItem(currentGatewaySelectionKeyForPage(pageDerivedUrl)),
    );
    const selected = selectedGatewayUrl
      ? readSettingsForGateway(storage, selectedGatewayUrl)
      : null;
    // Legacy state has no page owner. Only the current page target or a deliberate
    // cross-origin remote can claim it; ambiguous same-origin sibling paths cannot.
    const defaultSource = readSettingsForGateway(storage, defaultUrl, {
      includeLegacy: true,
      legacyAliases: [pageDerivedUrl],
      remoteLegacyPageUrl: pageDerivedUrl,
    });
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
      chatAutoScroll: normalizeChatAutoScrollMode(parsed.chatAutoScroll),
      chatSendShortcut: normalizeChatSendShortcut(parsed.chatSendShortcut),
      realtimeTalkInputDeviceId: normalizeOptionalString(parsed.realtimeTalkInputDeviceId),
      splitRatio:
        typeof parsed.splitRatio === "number" &&
        parsed.splitRatio >= 0.4 &&
        parsed.splitRatio <= 0.7
          ? parsed.splitRatio
          : defaults.splitRatio,
      chatSplitLayout: normalizeChatSplitLayout(parsed.chatSplitLayout),
      chatWorkspaceDock: normalizeChatWorkspaceDock(parsed.chatWorkspaceDock),
      navCollapsed:
        typeof parsed.navCollapsed === "boolean" ? parsed.navCollapsed : defaults.navCollapsed,
      navWidth:
        typeof parsed.navWidth === "number" &&
        parsed.navWidth >= NAV_WIDTH_MIN &&
        parsed.navWidth <= NAV_WIDTH_MAX
          ? parsed.navWidth
          : defaults.navWidth,
      sidebarPinnedRoutes:
        normalizeSidebarPinnedRoutes(parsed.sidebarPinnedRoutes) ?? defaults.sidebarPinnedRoutes,
      sidebarMoreExpanded:
        typeof parsed.sidebarMoreExpanded === "boolean"
          ? parsed.sidebarMoreExpanded
          : defaults.sidebarMoreExpanded,
      textScale: normalizeTextScale(parsed.textScale, defaults.textScale),
      customTheme: customTheme ?? undefined,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
      ...(parsed.lobsterPetVisits === false ? { lobsterPetVisits: false } : {}),
    };
    if (source.legacy || "token" in parsed) {
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

export function patchSettings(patch: Partial<UiSettings>): UiSettings {
  const next = { ...loadSettings(), ...patch };
  persistSettings(next, { selectGateway: patch.gatewayUrl !== undefined });
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
  let existingSessionsByGateway: Record<string, ScopedSessionSelection> = {};
  try {
    const source = readSettingsForGateway(storage, next.gatewayUrl, { includeLegacy: true });
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
    chatPersistCommentary: next.chatPersistCommentary ?? false,
    chatAutoScroll: normalizeChatAutoScrollMode(next.chatAutoScroll),
    ...(normalizeChatSendShortcut(next.chatSendShortcut) === "modifier-enter"
      ? { chatSendShortcut: "modifier-enter" as const }
      : {}),
    ...(normalizeOptionalString(next.realtimeTalkInputDeviceId)
      ? { realtimeTalkInputDeviceId: normalizeOptionalString(next.realtimeTalkInputDeviceId) }
      : {}),
    splitRatio: next.splitRatio,
    ...(next.chatSplitLayout ? { chatSplitLayout: next.chatSplitLayout } : {}),
    // Right dock is the default; only the opt-in bottom dock persists.
    ...(next.chatWorkspaceDock === "bottom" ? { chatWorkspaceDock: "bottom" as const } : {}),
    navCollapsed: next.navCollapsed,
    navWidth: next.navWidth,
    sidebarPinnedRoutes: next.sidebarPinnedRoutes,
    sidebarMoreExpanded: next.sidebarMoreExpanded,
    textScale: normalizeTextScale(next.textScale),
    ...(next.customTheme ? { customTheme: next.customTheme } : {}),
    sessionsByGateway,
    ...(next.locale ? { locale: next.locale } : {}),
    // Visits default on; only an explicit opt-out persists.
    ...(next.lobsterPetVisits === false ? { lobsterPetVisits: false } : {}),
  };
  const serialized = JSON.stringify(persisted);
  try {
    const { pageUrl } = deriveDefaultGatewayUrl();
    const selectionKey = currentGatewaySelectionKeyForPage(pageUrl);
    storage?.setItem(scopedKey, serialized);
    if (options.selectGateway || storage?.getItem(selectionKey) == null) {
      storage?.setItem(selectionKey, next.gatewayUrl);
    }
    storage?.removeItem(LEGACY_SETTINGS_KEY);
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory settings and visual updates from being applied
  }
}
