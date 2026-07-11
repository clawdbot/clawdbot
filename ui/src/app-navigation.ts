// Control UI app navigation defines sidebar and settings presentation metadata.
import type { RouteId } from "./app-route-paths.ts";
import type { IconName } from "./components/icons.ts";
import { t } from "./i18n/index.ts";

export type NavigationRouteId = RouteId;

type NavigationItem = {
  [TRouteId in NavigationRouteId]: IconName;
};

// The sidebar shows a small user-customizable pinned set; every other nav route
// lives in the collapsed "More" section. Chat is reachable through the session
// list and Settings/Docs live in the sidebar footer, so neither is listed here.
export const SIDEBAR_NAV_ROUTES = [
  "overview",
  "activity",
  "workboard",
  "instances",
  "sessions",
  "usage",
  "cron",
  "tasks",
  "agents",
  "skills",
  "plugins",
  "skill-workshop",
  "nodes",
  "dreams",
] as const satisfies readonly NavigationRouteId[];

export type SidebarNavRoute = (typeof SIDEBAR_NAV_ROUTES)[number];

// Sessions are the sidebar's core content; Overview is the only page pinned by
// default. Users pin more via the customize menu.
export const DEFAULT_SIDEBAR_PINNED_ROUTES = [
  "overview",
] as const satisfies readonly SidebarNavRoute[];

/**
 * Normalize a persisted pinned-route list. Returns null when the value is not a
 * list (caller falls back to defaults); unknown or duplicate entries are dropped
 * so prefs survive route renames/removals without a migration.
 */
export function normalizeSidebarPinnedRoutes(value: unknown): SidebarNavRoute[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const pinned: SidebarNavRoute[] = [];
  for (const entry of value) {
    if (
      typeof entry === "string" &&
      (SIDEBAR_NAV_ROUTES as readonly string[]).includes(entry) &&
      !pinned.includes(entry as SidebarNavRoute)
    ) {
      pinned.push(entry as SidebarNavRoute);
    }
  }
  return pinned;
}

export function sidebarMoreRoutes(pinned: readonly SidebarNavRoute[]): SidebarNavRoute[] {
  return SIDEBAR_NAV_ROUTES.filter((routeId) => !pinned.includes(routeId));
}

type SettingsNavigationGroup = {
  /** i18n key for the group heading; null renders the group without a label. */
  labelKey: string | null;
  routes: readonly NavigationRouteId[];
};

// Grouping feeds the full-page settings sidebar (settings-sidebar.ts).
export const SETTINGS_NAVIGATION_GROUPS = [
  { labelKey: null, routes: ["profile", "config", "appearance"] },
  { labelKey: "nav.settingsGroupConnections", routes: ["channels", "communications"] },
  {
    labelKey: "nav.settingsGroupAgents",
    routes: ["ai-agents", "model-providers", "automation", "mcp"],
  },
  {
    labelKey: "nav.settingsGroupSystem",
    routes: ["infrastructure", "worktrees", "debug", "logs", "about"],
  },
] as const satisfies readonly SettingsNavigationGroup[];

export const SETTINGS_NAVIGATION_ROUTES: readonly NavigationRouteId[] =
  SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes);

const NAVIGATION_ICONS: NavigationItem = {
  agents: "bot",
  activity: "activity",
  overview: "barChart",
  workboard: "kanban",
  worktrees: "folder",
  channels: "link",
  instances: "radio",
  sessions: "fileText",
  usage: "barChart",
  cron: "calendarClock",
  tasks: "listChecks",
  skills: "zap",
  plugins: "puzzle",
  "skill-workshop": "wrench",
  nodes: "monitor",
  chat: "messageSquare",
  config: "settings",
  profile: "lobster",
  communications: "send",
  appearance: "spark",
  automation: "terminal",
  mcp: "wrench",
  infrastructure: "globe",
  about: "fileText",
  "ai-agents": "brain",
  "model-providers": "plug",
  debug: "bug",
  logs: "scrollText",
  dreams: "moon",
  plugin: "puzzle",
};

export function isSettingsNavigationRoute(routeId: NavigationRouteId): boolean {
  return (SETTINGS_NAVIGATION_ROUTES as readonly NavigationRouteId[]).includes(routeId);
}

export function navigationIconForRoute(routeId: NavigationRouteId): IconName {
  return NAVIGATION_ICONS[routeId] ?? "folder";
}

export function scheduleRoutePreload<TRouteId extends string>(
  timers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>,
  routeId: TRouteId,
  event: Event,
  preload: ((routeId: TRouteId) => Promise<void> | void) | undefined,
  disabled = false,
  immediate = false,
) {
  if (disabled || !preload) {
    return;
  }
  const target = event.currentTarget;
  if (!target) {
    return;
  }
  const start = () => {
    timers.delete(target);
    try {
      void Promise.resolve(preload(routeId)).catch(() => undefined);
    } catch {
      // Preloading is opportunistic; navigation still handles real route errors.
    }
  };
  if (immediate) {
    cancelRoutePreload(timers, event);
    start();
    return;
  }
  if (!timers.has(target)) {
    timers.set(target, globalThis.setTimeout(start, 50));
  }
}

export function cancelRoutePreload(
  timers: Map<EventTarget, ReturnType<typeof globalThis.setTimeout>>,
  event: Event,
) {
  const target = event.currentTarget;
  if (!target) {
    return;
  }
  const timer = timers.get(target);
  if (timer !== undefined) {
    globalThis.clearTimeout(timer);
    timers.delete(target);
  }
}

const NAVIGATION_COPY: Record<NavigationRouteId, { titleKey: string; subtitleKey: string }> = {
  agents: { titleKey: "tabs.agents", subtitleKey: "subtitles.agents" },
  activity: { titleKey: "tabs.activity", subtitleKey: "subtitles.activity" },
  overview: { titleKey: "tabs.overview", subtitleKey: "subtitles.overview" },
  workboard: { titleKey: "tabs.workboard", subtitleKey: "subtitles.workboard" },
  worktrees: { titleKey: "tabs.worktrees", subtitleKey: "subtitles.worktrees" },
  channels: { titleKey: "tabs.channels", subtitleKey: "subtitles.channels" },
  instances: { titleKey: "tabs.instances", subtitleKey: "subtitles.instances" },
  sessions: { titleKey: "tabs.sessions", subtitleKey: "subtitles.sessions" },
  usage: { titleKey: "tabs.usage", subtitleKey: "subtitles.usage" },
  cron: { titleKey: "tabs.cron", subtitleKey: "subtitles.cron" },
  tasks: { titleKey: "tabs.tasks", subtitleKey: "subtitles.tasks" },
  skills: { titleKey: "tabs.skills", subtitleKey: "subtitles.skills" },
  plugins: { titleKey: "tabs.plugins", subtitleKey: "subtitles.plugins" },
  "skill-workshop": {
    titleKey: "tabs.skillWorkshop",
    subtitleKey: "subtitles.skillWorkshop",
  },
  nodes: { titleKey: "tabs.nodes", subtitleKey: "subtitles.nodes" },
  chat: { titleKey: "tabs.chat", subtitleKey: "subtitles.chat" },
  config: { titleKey: "nav.settings", subtitleKey: "subtitles.config" },
  profile: { titleKey: "tabs.profile", subtitleKey: "subtitles.profile" },
  communications: {
    titleKey: "tabs.communications",
    subtitleKey: "subtitles.communications",
  },
  appearance: { titleKey: "tabs.appearance", subtitleKey: "subtitles.appearance" },
  automation: { titleKey: "tabs.automation", subtitleKey: "subtitles.automation" },
  mcp: { titleKey: "tabs.mcp", subtitleKey: "subtitles.mcp" },
  infrastructure: { titleKey: "tabs.infrastructure", subtitleKey: "subtitles.infrastructure" },
  about: { titleKey: "tabs.about", subtitleKey: "subtitles.about" },
  "ai-agents": { titleKey: "tabs.aiAgents", subtitleKey: "subtitles.aiAgents" },
  "model-providers": {
    titleKey: "tabs.modelProviders",
    subtitleKey: "subtitles.modelProviders",
  },
  debug: { titleKey: "tabs.debug", subtitleKey: "subtitles.debug" },
  logs: { titleKey: "tabs.logs", subtitleKey: "subtitles.logs" },
  dreams: { titleKey: "tabs.dreams", subtitleKey: "subtitles.dreams" },
  plugin: { titleKey: "tabs.plugin", subtitleKey: "subtitles.plugin" },
};

export function titleForRoute(routeId: NavigationRouteId): string {
  return t(NAVIGATION_COPY[routeId].titleKey);
}

/**
 * Sidebar item label inside the settings takeover. The config route is titled
 * "Settings" globally (gear tooltip, palette) but reads "General" next to its
 * sibling sections.
 */
export function settingsNavigationLabelForRoute(routeId: NavigationRouteId): string {
  return routeId === "config" ? t("nav.settingsGeneral") : titleForRoute(routeId);
}

export function subtitleForRoute(routeId: NavigationRouteId): string {
  return t(NAVIGATION_COPY[routeId].subtitleKey);
}
