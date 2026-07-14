// Control UI app navigation defines sidebar and settings presentation metadata.
import type { RouteId } from "./app-route-paths.ts";
import type { IconName } from "./components/icons.ts";
import { i18n, t } from "./i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "./lib/string-coerce.ts";

export type NavigationRouteId = RouteId;

type NavigationItem = {
  [TRouteId in NavigationRouteId]: IconName;
};

// The sidebar shows a small user-customizable pinned set; every other nav route
// lives in the collapsed "More" section. Chat is reachable through the session
// list and Settings/Docs live in the sidebar footer, so neither is listed here.
// Skills and Skill Workshop are tabs inside the Plugins hub, not sidebar items.
// Session management lives in Settings (SETTINGS_NAVIGATION_GROUPS below).
export const SIDEBAR_NAV_ROUTES = [
  "workboard",
  "usage",
  "cron",
  "tasks",
  "plugins",
] as const satisfies readonly NavigationRouteId[];

// Routes presented as tabs of the Plugins hub. The sidebar highlights the
// Plugins entry for all of them, mirroring how config covers settings routes.
const PLUGINS_HUB_ROUTES: ReadonlySet<NavigationRouteId> = new Set([
  "plugins",
  "skills",
  "skill-workshop",
]);

export function isPluginsHubRoute(routeId: NavigationRouteId): boolean {
  return PLUGINS_HUB_ROUTES.has(routeId);
}

export type SidebarNavRoute = (typeof SIDEBAR_NAV_ROUTES)[number];

// Keep the highest-value operational destinations visible on first use. Users
// can still replace this set through the customize menu.
export const DEFAULT_SIDEBAR_PINNED_ROUTES = [
  "usage",
  "cron",
  "plugins",
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

export type SettingsSearchBlock = {
  routeId: RouteId;
  label: string;
  search?: string;
  hash: string;
};

let settingsSearchSegmenterLocale = "";
let settingsSearchSegmenter: Intl.Segmenter | null = null;

function settingsSearchHasWordPrefix(value: string, query: string): boolean {
  const locale = i18n.getLocale();
  if (settingsSearchSegmenterLocale !== locale) {
    settingsSearchSegmenterLocale = locale;
    settingsSearchSegmenter =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter(locale, { granularity: "word" })
        : null;
  }
  if (!settingsSearchSegmenter) {
    return value.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query));
  }
  for (const segment of settingsSearchSegmenter.segment(value)) {
    if (segment.isWordLike !== false && segment.segment.startsWith(query)) {
      return true;
    }
  }
  return false;
}

export function settingsSearchTextMatches(value: string, query: string): boolean {
  const candidate = normalizeLowercaseStringOrEmpty(value);
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query);
  if (!normalizedQuery) {
    return false;
  }
  if (normalizedQuery.length > 2) {
    return candidate.includes(normalizedQuery);
  }
  return settingsSearchHasWordPrefix(candidate, normalizedQuery);
}

// Grouping feeds the full-page settings sidebar (settings-sidebar.ts).
export const SETTINGS_NAVIGATION_GROUPS = [
  { labelKey: null, routes: ["profile", "config", "appearance"] },
  {
    labelKey: "nav.settingsGroupConnections",
    routes: ["connection", "channels", "communications"],
  },
  {
    labelKey: "nav.settingsGroupAgents",
    routes: [
      "agents",
      "ai-agents",
      "sessions",
      "memory-import",
      "model-providers",
      "automation",
      "mcp",
    ],
  },
  {
    labelKey: "nav.settingsGroupSystem",
    routes: ["infrastructure", "nodes", "worktrees", "debug", "logs", "activity", "about"],
  },
] as const satisfies readonly SettingsNavigationGroup[];

const SETTINGS_NAVIGATION_ROUTES: readonly NavigationRouteId[] = SETTINGS_NAVIGATION_GROUPS.flatMap(
  (group) => group.routes,
);

const NAVIGATION_ICONS: NavigationItem = {
  agents: "bot",
  activity: "activity",
  workboard: "kanban",
  worktrees: "folder",
  channels: "link",
  connection: "radio",
  sessions: "fileText",
  usage: "coins",
  cron: "calendarClock",
  tasks: "listChecks",
  skills: "zap",
  plugins: "puzzle",
  "skill-workshop": "wrench",
  nodes: "monitorSmartphone",
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
  "memory-import": "download",
  debug: "bug",
  logs: "scrollText",
  plugin: "puzzle",
  "new-session": "plus",
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
  workboard: { titleKey: "tabs.workboard", subtitleKey: "subtitles.workboard" },
  worktrees: { titleKey: "tabs.worktrees", subtitleKey: "subtitles.worktrees" },
  channels: { titleKey: "tabs.channels", subtitleKey: "subtitles.channels" },
  connection: { titleKey: "tabs.connection", subtitleKey: "subtitles.connection" },
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
  "memory-import": { titleKey: "tabs.memoryImport", subtitleKey: "subtitles.memoryImport" },
  debug: { titleKey: "tabs.debug", subtitleKey: "subtitles.debug" },
  logs: { titleKey: "tabs.logs", subtitleKey: "subtitles.logs" },
  plugin: { titleKey: "tabs.plugin", subtitleKey: "subtitles.plugin" },
  "new-session": { titleKey: "newSession.title", subtitleKey: "newSession.hint" },
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
