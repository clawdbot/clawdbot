import { loadConfig, loadConfigSchema } from "./controllers/config";
import { loadCronJobs, loadCronStatus } from "./controllers/cron";
import { loadChannels } from "./controllers/channels";
import { loadDebug } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";
import { loadDevices } from "./controllers/devices";
import { loadNodes } from "./controllers/nodes";
import { loadExecApprovals } from "./controllers/exec-approvals";
import { loadPresence } from "./controllers/presence";
import { loadSessions } from "./controllers/sessions";
import { loadSkills } from "./controllers/skills";
import { inferBasePathFromPathname, normalizeBasePath, normalizePath, pathForTab, tabFromPath, type Tab } from "./navigation";
import { saveSettings, type UiSettings } from "./storage";
import { resolveTheme, type ResolvedTheme, type ThemeMode } from "./theme";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition";
import { scheduleChatScroll, scheduleLogsScroll } from "./app-scroll";
import { startLogsPolling, stopLogsPolling, startDebugPolling, stopDebugPolling } from "./app-polling";
import { refreshChat } from "./app-chat";
import type { MoltbotApp } from "./app";

type SettingsHost = {
  settings: UiSettings;
  theme: ThemeMode;
  themeResolved: ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
};

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  if (next.theme !== host.theme) {
    host.theme = next.theme;
    applyResolvedTheme(host, resolveTheme(next.theme));
  }
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function setLastActiveSessionKey(host: SettingsHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed) return;
  if (host.settings.lastActiveSessionKey === trimmed) return;
  applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
}

export function applySettingsFromUrl(host: SettingsHost) {
  if (!window.location.search) return;
  const params = new URLSearchParams(window.location.search);
  const tokenRaw = params.get("token");
  const passwordRaw = params.get("password");
  const sessionRaw = params.get("session");
  const gatewayUrlRaw = params.get("gatewayUrl");
  let shouldCleanUrl = false;

  if (tokenRaw != null) {
    const token = tokenRaw.trim();
    if (token && token !== host.settings.token) {
      applySettings(host, { ...host.settings, token });
    }
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (passwordRaw != null) {
    const password = passwordRaw.trim();
    if (password) {
      (host as { password: string }).password = password;
    }
    params.delete("password");
    shouldCleanUrl = true;
  }

  if (sessionRaw != null) {
    const session = sessionRaw.trim();
    if (session) {
      host.sessionKey = session;
      applySettings(host, {
        ...host.settings,
        sessionKey: session,
        lastActiveSessionKey: session,
      });
    }
  }

  if (gatewayUrlRaw != null) {
    const gatewayUrl = gatewayUrlRaw.trim();
    if (gatewayUrl && gatewayUrl !== host.settings.gatewayUrl) {
      applySettings(host, { ...host.settings, gatewayUrl });
    }
    params.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) return;
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState({}, "", url.toString());
}

export function setTab(host: SettingsHost, next: Tab) {
  if (host.tab !== next) host.tab = next;
  if (next === "chat") host.chatHasAutoScrolled = false;
  if (next === "logs")
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  else stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  if (next === "debug")
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  else stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  void refreshActiveTab(host);
  syncUrlWithTab(host, next, false);
}

export function setTheme(
  host: SettingsHost,
  next: ThemeMode,
  context?: ThemeTransitionContext,
) {
  const applyTheme = () => {
    host.theme = next;
    applySettings(host, { ...host.settings, theme: next });
    applyResolvedTheme(host, resolveTheme(next));
  };
  startThemeTransition({
    nextTheme: next,
    applyTheme,
    context,
    currentTheme: host.theme,
  });
}

export async function refreshActiveTab(host: SettingsHost) {
  if (host.tab === "overview") await loadOverview(host);
  if (host.tab === "channels") await loadChannelsTab(host);
  if (host.tab === "instances") await loadPresence(host as unknown as MoltbotApp);
  if (host.tab === "sessions") await loadSessions(host as unknown as MoltbotApp);
  if (host.tab === "cron") await loadCron(host);
  if (host.tab === "skills") await loadSkills(host as unknown as MoltbotApp);
  if (host.tab === "nodes") {
    await loadNodes(host as unknown as MoltbotApp);
    await loadDevices(host as unknown as MoltbotApp);
    await loadConfig(host as unknown as MoltbotApp);
    await loadExecApprovals(host as unknown as MoltbotApp);
  }
  if (host.tab === "chat") {
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !host.chatHasAutoScrolled,
    );
  }
  if (host.tab === "config") {
    await loadConfigSchema(host as unknown as MoltbotApp);
    await loadConfig(host as unknown as MoltbotApp);
  }
  if (host.tab === "debug") {
    await loadDebug(host as unknown as MoltbotApp);
    host.eventLog = host.eventLogBuffer;
  }
  if (host.tab === "logs") {
    host.logsAtBottom = true;
    await loadLogs(host as unknown as MoltbotApp, { reset: true });
    scheduleLogsScroll(
      host as unknown as Parameters<typeof scheduleLogsScroll>[0],
      true,
    );
  }
}

export function inferBasePath() {
  if (typeof window === "undefined") return "";
  const configured = window.__CLAWDBOT_CONTROL_UI_BASE_PATH__;
  if (typeof configured === "string" && configured.trim()) {
    return normalizeBasePath(configured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  host.theme = host.settings.theme ?? "system";
  applyResolvedTheme(host, resolveTheme(host.theme));
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function attachThemeListener(host: SettingsHost) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  host.themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  host.themeMediaHandler = (event) => {
    if (host.theme !== "system") return;
    applyResolvedTheme(host, event.matches ? "dark" : "light");
  };
  if (typeof host.themeMedia.addEventListener === "function") {
    host.themeMedia.addEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    addListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(host.themeMediaHandler);
}

export function detachThemeListener(host: SettingsHost) {
  if (!host.themeMedia || !host.themeMediaHandler) return;
  if (typeof host.themeMedia.removeEventListener === "function") {
    host.themeMedia.removeEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    removeListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.removeListener(host.themeMediaHandler);
  host.themeMedia = null;
  host.themeMediaHandler = null;
}

export function syncTabWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") return;
  const resolved = tabFromPath(window.location.pathname, host.basePath) ?? "chat";
  setTabFromRoute(host, resolved);
  syncUrlWithTab(host, resolved, replace);
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") return;
  const resolved = tabFromPath(window.location.pathname, host.basePath);
  if (!resolved) return;

  const url = new URL(window.location.href);
  const session = url.searchParams.get("session")?.trim();
  if (session) {
    host.sessionKey = session;
    applySettings(host, {
      ...host.settings,
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }

  setTabFromRoute(host, resolved);
}

export function setTabFromRoute(host: SettingsHost, next: Tab) {
  if (host.tab !== next) host.tab = next;
  if (next === "chat") host.chatHasAutoScrolled = false;
  if (next === "logs")
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  else stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  if (next === "debug")
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  else stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  if (host.connected) void refreshActiveTab(host);
}

export function syncUrlWithTab(host: SettingsHost, tab: Tab, replace: boolean) {
  if (typeof window === "undefined") return;
  const targetPath = normalizePath(pathForTab(tab, host.basePath));
  const currentPath = normalizePath(window.location.pathname);
  const url = new URL(window.location.href);

  if (tab === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  } else {
    url.searchParams.delete("session");
  }

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export function syncUrlWithSessionKey(
  host: SettingsHost,
  sessionKey: string,
  replace: boolean,
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionKey);
  if (replace) window.history.replaceState({}, "", url.toString());
  else window.history.pushState({}, "", url.toString());
}

export async function loadOverview(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as MoltbotApp, false),
    loadPresence(host as unknown as MoltbotApp),
    loadSessions(host as unknown as MoltbotApp),
    loadCronStatus(host as unknown as MoltbotApp),
    loadDebug(host as unknown as MoltbotApp),
  ]);
}

export async function loadChannelsTab(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as MoltbotApp, true),
    loadConfigSchema(host as unknown as MoltbotApp),
    loadConfig(host as unknown as MoltbotApp),
  ]);
}

export async function loadCron(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as MoltbotApp, false),
    loadCronStatus(host as unknown as MoltbotApp),
    loadCronJobs(host as unknown as MoltbotApp),
  ]);
}
