import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isValidWorkboardBoardId } from "@openclaw/workboard-contract";
// Control UI app navigation defines sidebar and settings presentation metadata.
import type { RouteId } from "./app-route-paths.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "./app/native-device-settings.ts";
import type { IconName } from "./components/icons.ts";
import { i18n, t } from "./i18n/index.ts";

export type NavigationRouteId = RouteId;

type NavigationPresentation = readonly [icon: IconName, titleKey: string, subtitleKey: string];

// The sidebar shows a small user-customizable ordered zone; every other nav route
// lives in the collapsed "More" section. Chat is reachable through the session
// list and Settings/Docs live in the sidebar footer, so neither is listed here.
// Skills and Skill Workshop are tabs inside the Plugins hub, not sidebar items.
// Worktrees is a tab of the Sessions hub, so it is not listed either.
// Workboard is plugin-owned and enters the zone through its Control UI descriptor.
export const SIDEBAR_NAV_ROUTES = [
  "dashboards",
  "usage",
  "cron",
  "tasks",
  "sessions",
  "activity",
  "meetings",
  "plugins",
  "apps",
  "portals",
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

// Worktrees renders as a tab of the Sessions hub; the sidebar highlights the
// Sessions entry for both routes, mirroring the Plugins hub behavior.
const SESSIONS_HUB_ROUTES: ReadonlySet<NavigationRouteId> = new Set(["sessions", "worktrees"]);

export function isSessionsHubRoute(routeId: NavigationRouteId): boolean {
  return SESSIONS_HUB_ROUTES.has(routeId);
}

export type SidebarNavRoute = (typeof SIDEBAR_NAV_ROUTES)[number];
export type PersistedSidebarRoute = SidebarNavRoute;

function isPersistedSidebarRoute(value: unknown): value is PersistedSidebarRoute {
  return SIDEBAR_NAV_ROUTES.includes(value as PersistedSidebarRoute);
}

export type SidebarZoneEntry =
  | { type: "route"; route: PersistedSidebarRoute }
  | { type: "plugin"; key: string }
  | { type: "session"; key: string };

// Keep the highest-value operational destinations visible on first use. Users
// can still replace this route set through the customize menu.
export const DEFAULT_SIDEBAR_ENTRIES = ["dashboards", "cron", "plugins"].map((route) =>
  serializeSidebarEntry({ type: "route", route: route as SidebarNavRoute }),
);

/**
 * Parse the compact persisted representation used by browser and synced prefs.
 */
export function parseSidebarEntry(value: unknown): SidebarZoneEntry | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.startsWith("route:")) {
    const route = value.slice("route:".length);
    if (route === "workboard") {
      return { type: "plugin", key: "workboard/workboard" };
    }
    return isPersistedSidebarRoute(route) ? { type: "route", route } : null;
  }
  if (value.startsWith("session:")) {
    const key = value.slice("session:".length).trim();
    return key ? { type: "session", key } : null;
  }
  if (value.startsWith("workboard:")) {
    const boardId = value.slice("workboard:".length).trim();
    // Normalize the shipped Workboard pin format at the preference boundary.
    return isValidWorkboardBoardId(boardId)
      ? { type: "plugin", key: `workboard/board-${boardId}` }
      : null;
  }
  if (value.startsWith("plugin:")) {
    const key = value.slice("plugin:".length);
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)
      ? { type: "plugin", key }
      : null;
  }
  return null;
}

export function serializeSidebarEntry(entry: SidebarZoneEntry): string {
  if (entry.type === "route") {
    return `route:${entry.route}`;
  }
  return entry.type === "plugin" ? `plugin:${entry.key}` : `session:${entry.key}`;
}

/**
 * Normalize a persisted sidebar-zone list. Returns null when the value is not a
 * list; malformed and duplicate entries are dropped.
 */
export function normalizeSidebarEntries(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const valueEntry of value) {
    const parsed = parseSidebarEntry(valueEntry);
    if (!parsed) {
      continue;
    }
    const entry = serializeSidebarEntry(parsed);
    if (!normalized.includes(entry)) {
      normalized.push(entry);
    }
  }
  return normalized;
}

export function sidebarMoreRoutes(entries: readonly string[]): SidebarNavRoute[] {
  const visibleRoutes = new Set(
    entries.flatMap((entry) => {
      const parsed = parseSidebarEntry(entry);
      return parsed?.type === "route" ? [parsed.route] : [];
    }),
  );
  return SIDEBAR_NAV_ROUTES.filter((routeId) => !visibleRoutes.has(routeId));
}

type SettingsNavigationGroup = {
  /** i18n key for the group heading; null renders the group without a label. */
  labelKey: string | null;
  routes: readonly NavigationRouteId[];
};

export type SettingsSearchBlock = {
  routeId: RouteId;
  label: string;
  pathname?: string;
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
  const candidate = normalizeLowercaseStringOrEmpty(value).normalize("NFC");
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query).normalize("NFC");
  if (!normalizedQuery) {
    return false;
  }
  if (normalizedQuery.length > 2) {
    return candidate.includes(normalizedQuery);
  }
  return settingsSearchHasWordPrefix(candidate, normalizedQuery);
}

// Grouping feeds the full-page settings sidebar (settings-sidebar.ts). Ordered
// by user attention: personal/look-and-feel first, system plumbing last.
// Management surfaces (sessions, worktrees, activity, memory import) are
// workspace destinations, not settings; model setup is a subpage of Models.
const SETTINGS_NAVIGATION_GROUPS = [
  { labelKey: null, routes: ["custodian", "profile", "appearance", "notifications"] },
  { labelKey: "nav.settingsGroupDevice", routes: ["device", "device-permissions"] },
  {
    labelKey: "nav.settingsGroupConnections",
    routes: ["connection", "channels", "communications", "talk", "devices", "cloud-workers"],
  },
  {
    labelKey: "nav.settingsGroupAgents",
    routes: ["agents", "labs", "model-providers", "mcp", "memory", "automation"],
  },
  {
    labelKey: "nav.settingsGroupSecurity",
    routes: ["security", "secrets", "approvals"],
  },
  {
    labelKey: "nav.settingsGroupSystem",
    routes: ["infrastructure", "advanced", "debug", "logs", "updates", "about"],
  },
] as const satisfies readonly SettingsNavigationGroup[];

const NON_ADMIN_SETTINGS_NAVIGATION_GROUPS = [
  { labelKey: null, routes: ["profile", "appearance", "notifications"] },
  { labelKey: "nav.settingsGroupDevice", routes: ["device", "device-permissions"] },
  {
    labelKey: "nav.settingsGroupConnections",
    routes: ["connection", "channels", "talk", "devices"],
  },
  {
    labelKey: "nav.settingsGroupAgents",
    routes: ["agents", "model-providers", "memory"],
  },
  { labelKey: "nav.settingsGroupSecurity", routes: ["approvals"] },
  {
    labelKey: "nav.settingsGroupSystem",
    routes: ["advanced", "debug", "logs", "updates", "about"],
  },
] as const satisfies readonly SettingsNavigationGroup[];

export function isSettingsNavigationRouteVisible(
  routeId: NavigationRouteId,
  canAdmin: boolean,
  nativeDeviceSettings: NativeDeviceSettingsCapability | null = null,
): boolean {
  if (routeId === "device" || routeId === "device-permissions") {
    return nativeDeviceSettings !== null;
  }
  if (routeId === "updates") {
    return canAdmin || nativeDeviceSettings !== null;
  }
  return (
    canAdmin ||
    NON_ADMIN_SETTINGS_NAVIGATION_GROUPS.some((group) =>
      group.routes.some((candidate) => candidate === routeId),
    )
  );
}

export function deviceSettingsGroupLabelKey(
  snapshot?: NativeDeviceSettingsSnapshot | null,
): string {
  const device = snapshot?.device;
  if (device?.platform === "macos") {
    return "nav.settingsGroupDevice";
  }
  if (device?.platform === "ios") {
    if (device.formFactor === "phone") {
      return "nav.settingsGroupThisIPhone";
    }
    if (device.formFactor === "pad") {
      return "nav.settingsGroupThisIPad";
    }
  }
  return "nav.settingsGroupThisDevice";
}

export function visibleSettingsNavigationGroups(
  canAdmin: boolean,
  nativeDeviceSettings: NativeDeviceSettingsCapability | null = null,
): readonly SettingsNavigationGroup[] {
  const groups = canAdmin ? SETTINGS_NAVIGATION_GROUPS : NON_ADMIN_SETTINGS_NAVIGATION_GROUPS;
  return groups
    .map((group) => ({
      labelKey:
        group.labelKey === "nav.settingsGroupDevice"
          ? deviceSettingsGroupLabelKey(nativeDeviceSettings?.snapshot)
          : group.labelKey,
      routes: group.routes.filter((route) =>
        isSettingsNavigationRouteVisible(route, canAdmin, nativeDeviceSettings),
      ),
    }))
    .filter((group) => group.routes.length > 0);
}

// Settings subpages render with settings chrome but stay out of the sidebar.
// Subpages with a visible owner keep that owner selected so users retain
// location context while completing the nested flow.
const SETTINGS_SUBPAGE_ROUTES: readonly NavigationRouteId[] = [
  "ai-agents",
  "model-setup",
  "lobsterdex",
];
export const SETTINGS_SEARCHABLE_SUBPAGE_ROUTES: readonly NavigationRouteId[] = ["ai-agents"];
const SETTINGS_SUBPAGE_OWNER_ROUTES: Partial<
  Readonly<Record<NavigationRouteId, NavigationRouteId>>
> = {
  "ai-agents": "agents",
  "model-setup": "model-providers",
};

const SETTINGS_NAVIGATION_ROUTES: ReadonlySet<NavigationRouteId> = new Set([
  ...SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes),
  ...SETTINGS_SUBPAGE_ROUTES,
]);

const NAVIGATION_PRESENTATION: Record<NavigationRouteId, NavigationPresentation> = {
  settings: ["settings", "nav.settings", "common.settingsSections"],
  agents: ["bot", "tabs.agents", "subtitles.agents"],
  activity: ["activity", "tabs.activity", "subtitles.activity"],
  meetings: ["book", "tabs.meetings", "subtitles.meetings"],
  apps: ["layoutGrid", "tabs.apps", "subtitles.apps"],
  portals: ["monitor", "tabs.portals", "subtitles.portals"],
  approvals: ["badgeCheck", "tabs.approvals", "subtitles.approvals"],
  workboard: ["kanban", "tabs.workboard", "subtitles.workboard"],
  worktrees: ["folder", "tabs.worktrees", "subtitles.worktrees"],
  channels: ["link", "tabs.channels", "subtitles.channels"],
  connection: ["radio", "tabs.connection", "subtitles.connection"],
  sessions: ["fileText", "tabs.sessions", "subtitles.sessions"],
  usage: ["coins", "tabs.usage", "subtitles.usage"],
  cron: ["calendarClock", "tabs.cron", "subtitles.cron"],
  tasks: ["listChecks", "tabs.tasks", "subtitles.tasks"],
  skills: ["zap", "tabs.skills", "subtitles.skills"],
  plugins: ["puzzle", "tabs.plugins", "subtitles.plugins"],
  "skill-workshop": ["wrench", "tabs.skillWorkshop", "subtitles.skillWorkshop"],
  device: ["monitor", "tabs.device", "subtitles.device"],
  "device-permissions": ["shieldCheck", "tabs.devicePermissions", "subtitles.devicePermissions"],
  devices: ["monitorSmartphone", "tabs.devices", "subtitles.devices"],
  "cloud-workers": ["server", "tabs.cloudWorkers", "subtitles.cloudWorkers"],
  chat: ["messageSquare", "tabs.chat", "subtitles.chat"],
  dashboard: ["layoutDashboard", "tabs.chat", "subtitles.chat"],
  dashboards: ["layoutDashboard", "tabs.dashboards", "subtitles.dashboards"],
  custodian: ["lobster", "tabs.custodian", "subtitles.custodian"],
  config: ["settings", "nav.settings", "subtitles.config"],
  profile: ["circleUser", "tabs.profile", "subtitles.profile"],
  communications: ["send", "tabs.communications", "subtitles.communications"],
  appearance: ["palette", "tabs.appearance", "subtitles.appearance"],
  lobsterdex: ["bug", "tabs.lobsterdex", "subtitles.lobsterdex"],
  automation: ["terminal", "tabs.automation", "subtitles.automation"],
  mcp: ["wrench", "tabs.mcp", "subtitles.mcp"],
  memory: ["book", "tabs.memory", "subtitles.memory"],
  talk: ["mic", "tabs.talk", "subtitles.talk"],
  infrastructure: ["globe", "tabs.infrastructure", "subtitles.infrastructure"],
  labs: ["flaskConical", "tabs.labs", "subtitles.labs"],
  updates: ["download", "tabs.updates", "subtitles.updates"],
  about: ["fileText", "tabs.about", "subtitles.about"],
  "ai-agents": ["brain", "tabs.aiAgents", "subtitles.aiAgents"],
  "model-setup": ["spark", "tabs.modelSetup", "subtitles.modelSetup"],
  "model-providers": ["box", "routeTitles.modelProviders", "subtitles.modelProviders"],
  "memory-import": ["download", "tabs.memoryImport", "subtitles.memoryImport"],
  notifications: ["bell", "routeTitles.notifications", "subtitles.notifications"],
  security: ["shieldCheck", "tabs.security", "subtitles.security"],
  secrets: ["key", "tabs.secrets", "secretsStore.hint"],
  advanced: ["fileCode", "routeTitles.advanced", "subtitles.advanced"],
  debug: ["bug", "tabs.debug", "subtitles.debug"],
  logs: ["scrollText", "tabs.logs", "subtitles.logs"],
  plugin: ["puzzle", "tabs.plugin", "subtitles.plugin"],
  "new-session": ["plus", "newSession.title", "newSession.hint"],
};

export function isSettingsNavigationRoute(routeId: NavigationRouteId): boolean {
  return SETTINGS_NAVIGATION_ROUTES.has(routeId);
}

export function isSettingsTakeover(routeId: RouteId | undefined): boolean {
  return routeId !== undefined && isSettingsNavigationRoute(routeId);
}

export function settingsNavigationOwnerRoute(routeId: NavigationRouteId): NavigationRouteId {
  return SETTINGS_SUBPAGE_OWNER_ROUTES[routeId] ?? routeId;
}

export function navigationIconForRoute(routeId: NavigationRouteId): IconName {
  return NAVIGATION_PRESENTATION[routeId]?.[0] ?? "folder";
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

export function titleForRoute(routeId: NavigationRouteId): string {
  const [, titleKey] = NAVIGATION_PRESENTATION[routeId];
  return t(titleKey);
}

/** Window/tab title, markers leftmost because tabs truncate from the right.
 * A disconnected Gateway replaces the approval count (a stale queue is not
 * actionable) and carries the pending-outbox total; titles already ending in the brand
 * ("Ask OpenClaw") skip the suffix so it never reads "… OpenClaw — OpenClaw". */
export function formatDocumentTitle(options: {
  context: string;
  attentionCount?: number;
  gatewayDisconnected?: boolean;
  queuedCount?: number;
}): string {
  const base = options.context.endsWith("OpenClaw")
    ? options.context
    : `${options.context} — OpenClaw`;
  if (options.gatewayDisconnected) {
    const queued =
      options.queuedCount && options.queuedCount > 0
        ? ` · ${t("connection.queuedCount", { count: String(options.queuedCount) })}`
        : "";
    return `(${t("connection.disconnectedTitle")}${queued}) ${base}`;
  }
  if (options.attentionCount && options.attentionCount > 0) {
    return `(${options.attentionCount}) ${base}`;
  }
  return base;
}

export function settingsNavigationLabelForRoute(
  routeId: NavigationRouteId,
  snapshot?: NativeDeviceSettingsSnapshot | null,
): string {
  if (routeId === "device" && snapshot) {
    return t(deviceSettingsGroupLabelKey(snapshot));
  }
  if (routeId === "custodian") {
    return t("nav.askOpenClaw");
  }
  return titleForRoute(routeId);
}

export function subtitleForRoute(routeId: NavigationRouteId): string {
  const subtitleKey = NAVIGATION_PRESENTATION[routeId][2];
  return t(subtitleKey);
}
