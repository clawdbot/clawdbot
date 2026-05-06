import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { t } from "../i18n/index.ts";
import { refreshChat } from "./app-chat.ts";
import {
  startLogsPolling,
  stopLogsPolling,
  startDebugPolling,
  stopDebugPolling,
} from "./app-polling.ts";
import { scheduleChatScroll, scheduleLogsScroll } from "./app-scroll.ts";
import {
  beginControlUiRefresh,
  controlUiNowMs,
  finishControlUiRefresh,
  recordControlUiPerformanceEvent,
  roundedControlUiDurationMs,
  scheduleControlUiTabVisibleTiming,
} from "./control-ui-performance.ts";
import { loadAgentFiles, type AgentFilesState } from "./controllers/agent-files.ts";
import {
  loadAgentIdentities,
  loadAgentIdentity,
  type AgentIdentityState,
} from "./controllers/agent-identity.ts";
import { loadAgentSkills, type AgentSkillsState } from "./controllers/agent-skills.ts";
import { loadAgents, type AgentsState } from "./controllers/agents.ts";
import { loadChannels, type ChannelsState } from "./controllers/channels.ts";
import { loadConfig, loadConfigSchema, type ConfigState } from "./controllers/config.ts";
import {
  loadCronJobsPage,
  loadCronRuns,
  loadCronStatus,
  type CronState,
} from "./controllers/cron.ts";
import { loadDebug, type DebugState } from "./controllers/debug.ts";
import { loadDevices, type DevicesState } from "./controllers/devices.ts";
import {
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
  type DreamingState,
} from "./controllers/dreaming.ts";
import { loadExecApprovals, type ExecApprovalsState } from "./controllers/exec-approvals.ts";
import { loadLogs, type LogsState } from "./controllers/logs.ts";
import {
  loadModelAuthStatusState,
  type ModelAuthStatusState,
} from "./controllers/model-auth-status.ts";
import { loadNodes, type NodesState } from "./controllers/nodes.ts";
import { loadPresence, type PresenceState } from "./controllers/presence.ts";
import { loadSessions, type SessionsState } from "./controllers/sessions.ts";
import { loadSkills, type SkillsState } from "./controllers/skills.ts";
import { loadUsage, type UsageState } from "./controllers/usage.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { isMonitoredAuthProvider } from "./model-auth-helpers.ts";
import {
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  tabFromPath,
  type Tab,
} from "./navigation.ts";
import {
  saveLocalUserIdentity,
  saveSettings,
  type LocalUserIdentity,
  type UiSettings,
} from "./storage.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition.ts";
import { resolveTheme, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
import type { AgentsListResult, AttentionItem } from "./types.ts";
import { normalizeLocalUserIdentity } from "./user-identity.ts";
import { resetChatViewState } from "./views/chat.ts";

export { setLastActiveSessionKey } from "./app-last-active-session.ts";

type SettingsHost = {
  settings: UiSettings;
  userName?: string | null;
  userAvatar?: string | null;
  password?: string;
  theme: ThemeName;
  themeMode: ThemeMode;
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
  agentsList?: AgentsListResult | null;
  agentsSelectedId?: string | null;
  agentsPanel?: "overview" | "files" | "tools" | "skills" | "channels" | "cron";
  pendingGatewayUrl?: string | null;
  systemThemeCleanup?: (() => void) | null;
  pendingGatewayToken?: string | null;
  requestUpdate?: () => void;
  updateComplete?: Promise<unknown>;
  controlUiRefreshSeq?: number;
  controlUiTabPaintSeq?: number;
  controlUiOverviewRefreshSeq?: number;
  controlUiCronRefreshSeq?: number;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: import("./controllers/dreaming.js").DreamingStatus | null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
};

type LocalUserIdentityHost = {
  userName?: string | null;
  userAvatar?: string | null;
};

type SettingsAppHost = SettingsHost &
  AgentFilesState &
  AgentIdentityState &
  AgentSkillsState &
  AgentsState &
  ChannelsState &
  ConfigState &
  CronState &
  DebugState &
  DevicesState &
  DreamingState &
  ExecApprovalsState &
  LogsState &
  NodesState &
  PresenceState &
  SessionsState &
  SkillsState &
  ModelAuthStatusState &
  UsageState & {
    overviewLogCursor: number | null;
    overviewLogLines: string[];
    attentionItems: AttentionItem[];
    hello: { auth?: { role?: string; scopes?: string[] } } | null;
  };

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    lastActiveSessionKey:
      normalizeOptionalString(next.lastActiveSessionKey) ??
      normalizeOptionalString(next.sessionKey) ??
      "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  syncCustomThemeStyleTag(normalized.customTheme);
  if (next.theme !== host.theme || next.themeMode !== host.themeMode) {
    host.theme = next.theme;
    host.themeMode = next.themeMode;
    applyResolvedTheme(host, resolveTheme(next.theme, next.themeMode));
  }
  applyBorderRadius(next.borderRadius);
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function applyLocalUserIdentity(
  host: LocalUserIdentityHost,
  next: Partial<LocalUserIdentity>,
) {
  const normalized = normalizeLocalUserIdentity({
    name: host.userName,
    avatar: host.userAvatar,
    ...next,
  });
  host.userName = normalized.name;
  host.userAvatar = normalized.avatar;
  saveLocalUserIdentity(normalized);
}

function applySessionSelection(host: SettingsHost, session: string) {
  host.sessionKey = session;
  applySettings(host, {
    ...host.settings,
    sessionKey: session,
    lastActiveSessionKey: session,
  });
}

/** Set to true when the token is read from a query string (?token=) instead of a URL fragment. */
export let warnQueryToken = false;

export function applySettingsFromUrl(host: SettingsHost) {
  if (!window.location.search && !window.location.hash) {
    return;
  }
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

  const gatewayUrlRaw = params.get("gatewayUrl") ?? hashParams.get("gatewayUrl");
  const nextGatewayUrl = normalizeOptionalString(gatewayUrlRaw) ?? "";
  const gatewayUrlChanged = Boolean(nextGatewayUrl && nextGatewayUrl !== host.settings.gatewayUrl);
  // Prefer fragment tokens over query tokens. Fragments avoid server-side request
  // logs and referrer leakage; query-param tokens remain a one-time legacy fallback
  // for compatibility with older deep links.
  const queryToken = params.get("token");
  const hashToken = hashParams.get("token");
  const hasTokenParam = hashToken != null || queryToken != null;
  const token = normalizeOptionalString(hashToken ?? queryToken);
  const session = normalizeOptionalString(params.get("session") ?? hashParams.get("session"));
  const shouldResetSessionForToken = Boolean(token && !session && !gatewayUrlChanged);
  let shouldCleanUrl = false;

  if (params.has("token")) {
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (hasTokenParam) {
    if (queryToken != null) {
      warnQueryToken = true;
      console.warn(
        "[openclaw] Auth token passed as query parameter (?token=). Use URL fragment instead: #token=<token>. Query parameters may appear in server logs.",
      );
    }
    if (token && gatewayUrlChanged) {
      host.pendingGatewayToken = token;
    } else if (token && token !== host.settings.token) {
      applySettings(host, { ...host.settings, token });
    }
    hashParams.delete("token");
    shouldCleanUrl = true;
  }

  if (shouldResetSessionForToken) {
    host.sessionKey = "main";
    applySettings(host, {
      ...host.settings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
  }

  if (params.has("password") || hashParams.has("password")) {
    // Never hydrate password from URL params; strip only.
    params.delete("password");
    hashParams.delete("password");
    shouldCleanUrl = true;
  }

  if (session) {
    applySessionSelection(host, session);
  }

  if (gatewayUrlRaw != null) {
    host.pendingGatewayUrl = gatewayUrlChanged ? nextGatewayUrl : null;
    host.pendingGatewayToken = gatewayUrlChanged ? (token ?? null) : null;
    params.delete("gatewayUrl");
    hashParams.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) {
    return;
  }
  url.search = params.toString();
  const nextHash = hashParams.toString();
  url.hash = nextHash ? `#${nextHash}` : "";
  updateBrowserHistory(url, true);
}

export function setTab(host: SettingsHost, next: Tab) {
  applyTabSelection(host, next, { refreshPolicy: "always", syncUrl: true });
}

function applyThemeTransition(
  host: SettingsHost,
  nextTheme: ResolvedTheme,
  applyTheme: () => void,
  context?: ThemeTransitionContext,
) {
  startThemeTransition({
    nextTheme,
    applyTheme,
    context,
    currentTheme: host.themeResolved,
  });
  syncSystemThemeListener(host);
}

export function setTheme(host: SettingsHost, next: ThemeName, context?: ThemeTransitionContext) {
  applyThemeTransition(
    host,
    resolveTheme(next, host.themeMode),
    () => applySettings(host, { ...host.settings, theme: next }),
    context,
  );
}

export function setThemeMode(
  host: SettingsHost,
  next: ThemeMode,
  context?: ThemeTransitionContext,
) {
  applyThemeTransition(
    host,
    resolveTheme(host.theme, next),
    () => applySettings(host, { ...host.settings, themeMode: next }),
    context,
  );
}

async function refreshAgentsTab(host: SettingsHost, app: SettingsAppHost) {
  await loadAgents(app);
  await loadConfig(app);
  const agentIds = host.agentsList?.agents?.map((entry) => entry.id) ?? [];
  if (agentIds.length > 0) {
    void loadAgentIdentities(app, agentIds);
  }
  const agentId =
    host.agentsSelectedId ?? host.agentsList?.defaultId ?? host.agentsList?.agents?.[0]?.id;
  if (!agentId) {
    return;
  }
  void loadAgentIdentity(app, agentId);
  switch (host.agentsPanel) {
    case "files":
      void loadAgentFiles(app, agentId);
      return;
    case "skills":
      void loadAgentSkills(app, agentId);
      return;
    case "channels":
      void loadChannels(app, false);
      return;
    case "cron":
      void loadCron(host);
      return;
    case "overview":
    case "tools":
    case undefined:
      return;
  }
}

export async function refreshActiveTab(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  const refreshRun = beginControlUiRefresh(host, host.tab);
  try {
    switch (host.tab) {
      case "config":
      case "communications":
      case "appearance":
      case "automation":
      case "infrastructure":
      case "aiAgents":
        await loadConfigSchema(app);
        await loadConfig(app);
        break;
      case "overview":
        await loadOverview(host);
        break;
      case "channels":
        await loadChannelsTab(host);
        break;
      case "instances":
        await loadPresence(app);
        break;
      case "usage":
        await loadUsage(app);
        break;
      case "sessions":
        await loadSessions(app);
        break;
      case "cron":
        await loadCron(host);
        break;
      case "skills":
        await loadSkills(app);
        break;
      case "agents":
        await refreshAgentsTab(host, app);
        break;
      case "nodes":
        await loadNodes(app);
        await Promise.allSettled([loadDevices(app), loadConfig(app), loadExecApprovals(app)]);
        break;
      case "dreams":
        await loadConfig(app);
        await Promise.all([
          loadDreamingStatus(app),
          loadDreamDiary(app),
          loadWikiImportInsights(app),
          loadWikiMemoryPalace(app),
        ]);
        break;
      case "chat":
        await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
        scheduleChatScroll(
          host as unknown as Parameters<typeof scheduleChatScroll>[0],
          !host.chatHasAutoScrolled,
        );
        break;
      case "debug":
        await loadDebug(app);
        host.eventLog = host.eventLogBuffer;
        break;
      case "logs":
        host.logsAtBottom = true;
        await loadLogs(app, { reset: true });
        scheduleLogsScroll(host as unknown as Parameters<typeof scheduleLogsScroll>[0], true);
        break;
    }
    finishControlUiRefresh(host, refreshRun, "ok");
  } catch (err) {
    finishControlUiRefresh(host, refreshRun, "error");
    throw err;
  }
}

export function inferBasePath() {
  if (typeof window === "undefined") {
    return "";
  }
  const configured = window.__OPENCLAW_CONTROL_UI_BASE_PATH__;
  const normalizedConfigured = normalizeOptionalString(configured);
  if (normalizedConfigured) {
    return normalizeBasePath(normalizedConfigured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  syncCustomThemeStyleTag(host.settings.customTheme);
  const normalizedTheme =
    host.settings.theme === "custom" && !host.settings.customTheme
      ? "claw"
      : (host.settings.theme ?? "claw");
  host.theme = normalizedTheme;
  host.themeMode = host.settings.themeMode ?? "system";
  if (normalizedTheme !== host.settings.theme) {
    host.settings = { ...host.settings, theme: normalizedTheme };
    saveSettings(host.settings);
  }
  applyResolvedTheme(host, resolveTheme(host.theme, host.themeMode));
  applyBorderRadius(host.settings.borderRadius ?? 50);
  syncSystemThemeListener(host);
}

export function detachThemeListener(host: SettingsHost) {
  host.systemThemeCleanup?.();
  host.systemThemeCleanup = null;
}

const BASE_RADII = { sm: 6, md: 10, lg: 14, xl: 20, full: 9999, default: 10 };

export function applyBorderRadius(value: number) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const scale = value / 50;
  root.style.setProperty("--radius-sm", `${Math.round(BASE_RADII.sm * scale)}px`);
  root.style.setProperty("--radius-md", `${Math.round(BASE_RADII.md * scale)}px`);
  root.style.setProperty("--radius-lg", `${Math.round(BASE_RADII.lg * scale)}px`);
  root.style.setProperty("--radius-xl", `${Math.round(BASE_RADII.xl * scale)}px`);
  root.style.setProperty("--radius-full", `${Math.round(BASE_RADII.full * scale)}px`);
  root.style.setProperty("--radius", `${Math.round(BASE_RADII.default * scale)}px`);
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const themeMode = resolved.endsWith("light") ? "light" : "dark";
  root.dataset.theme = resolved;
  root.dataset.themeMode = themeMode;
  root.style.colorScheme = themeMode;
}

function syncSystemThemeListener(host: SettingsHost) {
  // Clean up existing listener if mode is not "system"
  if (host.themeMode !== "system") {
    host.systemThemeCleanup?.();
    host.systemThemeCleanup = null;
    return;
  }

  // Skip if listener already attached for this host
  if (host.systemThemeCleanup) {
    return;
  }

  if (typeof globalThis.matchMedia !== "function") {
    return;
  }

  const mql = globalThis.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (host.themeMode !== "system") {
      return;
    }
    applyResolvedTheme(host, resolveTheme(host.theme, "system"));
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    host.systemThemeCleanup = () => mql.removeEventListener("change", onChange);
    return;
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(onChange);
    host.systemThemeCleanup = () => mql.removeListener(onChange);
  }
}

export function syncTabWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath) ?? "chat";
  setTabFromRoute(host, resolved);
  syncUrlWithTab(host, resolved, replace);
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") {
    return;
  }
  const resolved = tabFromPath(window.location.pathname, host.basePath);
  if (!resolved) {
    return;
  }

  const url = new URL(window.location.href);
  const session = normalizeOptionalString(url.searchParams.get("session"));
  if (session) {
    applySessionSelection(host, session);
  }

  setTabFromRoute(host, resolved);
}

export function setTabFromRoute(host: SettingsHost, next: Tab) {
  applyTabSelection(host, next, { refreshPolicy: "connected" });
}

function updateBrowserHistory(url: URL, replace: boolean) {
  const history = typeof window === "undefined" ? undefined : window.history;
  if (!history) {
    return;
  }
  if (replace) {
    return history.replaceState({}, "", url.toString());
  }
  return history.pushState({}, "", url.toString());
}

function applyTabSelection(
  host: SettingsHost,
  next: Tab,
  options: { refreshPolicy: "always" | "connected"; syncUrl?: boolean },
) {
  const prev = host.tab;
  host.tab = next;
  if (prev !== next) {
    scheduleControlUiTabVisibleTiming(host, prev, next);
  }

  // Cleanup chat module state when navigating away from chat
  if (prev === "chat" && next !== "chat") {
    resetChatViewState();
  }

  if (next === "chat") {
    host.chatHasAutoScrolled = false;
  }
  (next === "logs" ? startLogsPolling : stopLogsPolling)(
    host as unknown as Parameters<typeof startLogsPolling>[0],
  );
  (next === "debug" ? startDebugPolling : stopDebugPolling)(
    host as unknown as Parameters<typeof startDebugPolling>[0],
  );

  if (options.refreshPolicy === "always" || host.connected) {
    void refreshActiveTab(host);
  }

  if (options.syncUrl) {
    syncUrlWithTab(host, next, false);
  }
}

export function syncUrlWithTab(host: SettingsHost, tab: Tab, replace: boolean) {
  const href = typeof window === "undefined" ? undefined : window.location?.href;
  const pathname = typeof window === "undefined" ? undefined : window.location?.pathname;
  if (!href || !pathname) {
    return;
  }
  const targetPath = normalizePath(pathForTab(tab, host.basePath));
  const currentPath = normalizePath(pathname);
  const url = new URL(href);

  if (tab === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  } else {
    url.searchParams.delete("session");
  }

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  updateBrowserHistory(url, replace);
}

export function syncUrlWithSessionKey(host: SettingsHost, sessionKey: string, replace: boolean) {
  const href = typeof window === "undefined" ? undefined : window.location?.href;
  if (!href) {
    return;
  }
  const url = new URL(href);
  url.searchParams.set("session", sessionKey);
  updateBrowserHistory(url, replace);
}

export async function loadOverview(host: SettingsHost, opts?: { refresh?: boolean }) {
  const app = host as SettingsAppHost;
  const overviewSeq = (host.controlUiOverviewRefreshSeq ?? 0) + 1;
  host.controlUiOverviewRefreshSeq = overviewSeq;
  const isCurrentOverviewRefresh = () =>
    host.controlUiOverviewRefreshSeq === overviewSeq && host.tab === "overview";

  await Promise.allSettled([
    loadChannels(app, false),
    loadPresence(app),
    loadSessions(app),
    loadCronStatus(app),
    loadCronJobsPage(app),
  ]);
  if (isCurrentOverviewRefresh()) {
    buildAttentionItems(app);
  }

  const secondaryStartedAtMs = controlUiNowMs();
  void Promise.allSettled([
    loadDebug(app),
    loadSkills(app),
    loadUsage(app),
    loadOverviewLogs(app),
    // `refresh: true` bypasses the gateway's 60s auth-status cache so a
    // user-initiated refresh surfaces post-re-auth state immediately.
    loadModelAuthStatusState(app, { refresh: opts?.refresh }),
  ]).then((results) => {
    if (!isCurrentOverviewRefresh()) {
      return;
    }
    const status = results.some((result) => result.status === "rejected") ? "error" : "ok";
    buildAttentionItems(app);
    recordControlUiPerformanceEvent(
      app,
      "control-ui.overview.secondary",
      {
        phase: "end",
        status,
        durationMs: roundedControlUiDurationMs(controlUiNowMs() - secondaryStartedAtMs),
      },
      { console: false },
    );
  });
}

export function hasOperatorReadAccess(
  auth: { role?: string; scopes?: readonly string[] } | null,
): boolean {
  if (!auth?.scopes) {
    return false;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: ["operator.read"],
    allowedScopes: auth.scopes,
  });
}

export function hasMissingSkillDependencies(
  missing: Record<string, unknown> | null | undefined,
): boolean {
  if (!missing) {
    return false;
  }
  return Object.values(missing).some((value) => Array.isArray(value) && value.length > 0);
}

async function loadOverviewLogs(host: SettingsAppHost) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const res = await host.client.request("logs.tail", {
      cursor: host.overviewLogCursor || undefined,
      limit: 100,
      maxBytes: 50_000,
    });
    const payload = res as {
      cursor?: number;
      lines?: unknown;
    };
    const lines = Array.isArray(payload.lines)
      ? payload.lines.filter((line): line is string => typeof line === "string")
      : [];
    host.overviewLogLines = [...host.overviewLogLines, ...lines].slice(-500);
    if (typeof payload.cursor === "number") {
      host.overviewLogCursor = payload.cursor;
    }
  } catch {
    /* non-critical */
  }
}

function buildAttentionItems(host: SettingsAppHost) {
  const items: AttentionItem[] = [];

  if (host.lastError) {
    items.push({
      severity: "error",
      icon: "x",
      title: "Gateway Error",
      description: host.lastError,
    });
  }

  const hello = host.hello;
  const auth = (hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ?? null;
  if (auth?.scopes && !hasOperatorReadAccess(auth)) {
    items.push({
      severity: "warning",
      icon: "key",
      title: "Missing operator.read scope",
      description:
        "This connection does not have the operator.read scope. Some features may be unavailable.",
      href: "https://docs.openclaw.ai/web/dashboard",
      external: true,
    });
  }

  const skills = host.skillsReport?.skills ?? [];
  const missingDeps = skills.filter((s) => !s.disabled && hasMissingSkillDependencies(s.missing));
  if (missingDeps.length > 0) {
    const names = missingDeps.slice(0, 3).map((s) => s.name);
    const more = missingDeps.length > 3 ? ` +${missingDeps.length - 3} more` : "";
    items.push({
      severity: "warning",
      icon: "zap",
      title: "Skills with missing dependencies",
      description: `${names.join(", ")}${more}`,
    });
  }

  const blocked = skills.filter((s) => s.blockedByAllowlist);
  if (blocked.length > 0) {
    items.push({
      severity: "warning",
      icon: "shield",
      title: `${blocked.length} skill${blocked.length > 1 ? "s" : ""} blocked`,
      description: blocked.map((s) => s.name).join(", "),
    });
  }

  const cronJobs = host.cronJobs ?? [];
  const failedCron = cronJobs.filter((j) => j.state?.lastStatus === "error");
  if (failedCron.length > 0) {
    items.push({
      severity: "error",
      icon: "clock",
      title: `${failedCron.length} cron job${failedCron.length > 1 ? "s" : ""} failed`,
      description: failedCron.map((j) => j.name).join(", "),
    });
  }

  const now = Date.now();
  const overdue = cronJobs.filter(
    (j) => j.enabled && j.state?.nextRunAtMs != null && now - j.state.nextRunAtMs > 300_000,
  );
  if (overdue.length > 0) {
    items.push({
      severity: "warning",
      icon: "clock",
      title: `${overdue.length} overdue job${overdue.length > 1 ? "s" : ""}`,
      description: overdue.map((j) => j.name).join(", "),
    });
  }

  const modelAuth = host.modelAuthStatusResult;
  if (modelAuth) {
    // Use the same predicate as the Overview card so the two stay in sync.
    // Without this, a `missing` provider shows up on the card but never
    // produces the re-auth attention callout.
    const monitored = (modelAuth.providers ?? []).filter(isMonitoredAuthProvider);
    const expiredProviders = monitored.filter(
      (p) => p.status === "expired" || p.status === "missing",
    );
    if (expiredProviders.length > 0) {
      items.push({
        severity: "error",
        icon: "key",
        title: t("overview.cards.modelAuthAttentionExpiredTitle"),
        description: t("overview.cards.modelAuthAttentionExpiredDesc", {
          providers: expiredProviders.map((p) => p.displayName).join(", "),
        }),
      });
    }
    const expiringProviders = monitored.filter((p) => p.status === "expiring");
    if (expiringProviders.length > 0) {
      items.push({
        severity: "warning",
        icon: "key",
        title: t("overview.cards.modelAuthAttentionExpiringTitle"),
        description: expiringProviders
          .map((p) =>
            t("overview.cards.modelAuthAttentionExpiringEntry", {
              provider: p.displayName,
              when: p.expiry?.label ?? "soon",
            }),
          )
          .join(", "),
      });
    }
  }

  host.attentionItems = items;
}

export async function loadChannelsTab(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  await Promise.all([
    loadChannels(app, true, { softTimeoutMs: 750 }),
    loadConfigSchema(app),
    loadConfig(app),
  ]);
}

export async function loadCron(host: SettingsHost) {
  const app = host as unknown as SettingsAppHost;
  const activeCronJobId = app.cronRunsScope === "job" ? app.cronRunsJobId : null;
  const cronSeq = (host.controlUiCronRefreshSeq ?? 0) + 1;
  host.controlUiCronRefreshSeq = cronSeq;
  const isCurrentCronRefresh = () =>
    host.controlUiCronRefreshSeq === cronSeq && host.tab === "cron";
  const runsStartedAtMs = controlUiNowMs();
  const runsRefresh = loadCronRuns(app, activeCronJobId)
    .catch(() => "error" as const)
    .then((status) => {
      if (!isCurrentCronRefresh()) {
        return;
      }
      recordControlUiPerformanceEvent(
        app,
        "control-ui.cron.runs",
        {
          phase: "end",
          status,
          durationMs: roundedControlUiDurationMs(controlUiNowMs() - runsStartedAtMs),
        },
        { console: false },
      );
    });
  void runsRefresh;
  await Promise.all([loadChannels(app, false), loadCronStatus(app), loadCronJobsPage(app)]);
}
