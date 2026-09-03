import { normalizeAtHashSlug } from "@openclaw/normalization-core/string-normalization";
import {
  inferControlUiFocusBasePath,
  matchControlUiCatalogSharePath,
  SESSION_UUID_SUFFIX_RE,
} from "@openclaw/session-url-contract";
import {
  normalizeRouteBasePath as normalizeBasePath,
  normalizeRoutePath as normalizePath,
} from "@openclaw/uirouter";
import type { RouteLocation } from "@openclaw/uirouter";
import { isValidWorkboardBoardId } from "@openclaw/workboard-contract";
import { DEFAULT_AGENT_PANEL, isAgentsPanel, type AgentsPanel } from "./lib/agents/panels.ts";
import type { BoardFace } from "./lib/board/settings.ts";
import { takeGraphemes } from "./lib/graphemes.ts";
export const INTERNAL_AGENT_PATH_PARAM = "__openclawAgentPath";
export const INTERNAL_ACTIVITY_PATH_PARAM = "__openclawActivityPath";
export const INTERNAL_SESSION_PATH_PARAM = "__openclawSessionPath";
export const INTERNAL_MEMORY_PATH_PARAM = "__openclawMemoryPath";
export const INTERNAL_PLUGINS_PATH_PARAM = "__openclawPluginsPath";
export const INTERNAL_WORKBOARD_PATH_PARAM = "__openclawWorkboardPath";
export const CONTROL_UI_DOCUMENT_ROUTE_PATHS = {
  approval: "/approve",
  question: "/ask",
} as const;

export type MemoryRouteTab = "overview" | "memories" | "dreams" | "settings";
export type PluginsHubRouteTab = "installed" | "discover";

type AgentRoutePath = {
  agentId: string;
  panel: AgentsPanel;
  panelSegment: AgentsPanel | null;
  invalidPanel: boolean;
};

const APP_ROUTE_DEFINITIONS = {
  chat: { path: "/chat" },
  dashboard: { path: "/dashboard" },
  dashboards: { path: "/dashboards" },
  custodian: { path: "/custodian" },
  "new-session": { path: "/new" },
  activity: { path: "/activity" },
  meetings: { path: "/meetings" },
  apps: { path: "/apps" },
  portals: { path: "/portals" },
  agents: { path: "/settings/agents", aliases: ["/agents"] },
  channels: { path: "/settings/channels", aliases: ["/channels"] },
  connection: { path: "/settings/connection" },
  config: { path: "/settings/general", aliases: ["/config"] },
  profile: { path: "/settings/profile", aliases: ["/profile"] },
  communications: { path: "/settings/communications", aliases: ["/communications"] },
  appearance: { path: "/settings/appearance", aliases: ["/appearance"] },
  lobsterdex: { path: "/settings/lobsterdex", aliases: ["/lobsterdex"] },
  notifications: { path: "/settings/notifications" },
  security: { path: "/settings/security" },
  secrets: { path: "/settings/secrets" },
  advanced: { path: "/settings/advanced" },
  approvals: { path: "/settings/approvals" },
  automation: { path: "/settings/automation", aliases: ["/automation"] },
  mcp: { path: "/settings/mcp", aliases: ["/mcp"] },
  memory: { path: "/settings/memory" },
  talk: { path: "/settings/talk" },
  infrastructure: { path: "/settings/infrastructure", aliases: ["/infrastructure"] },
  labs: { path: "/settings/labs" },
  updates: { path: "/settings/updates" },
  about: { path: "/settings/about" },
  "ai-agents": { path: "/settings/ai-agents", aliases: ["/ai-agents"] },
  "model-setup": { path: "/settings/model-setup", aliases: ["/model-setup"] },
  "model-providers": { path: "/settings/model-providers", aliases: ["/model-providers"] },
  // Memory import, sessions, and worktrees are workspace destinations; the
  // /settings/* aliases keep pre-restructure bookmarks and deep links working.
  "memory-import": { path: "/memory-import", aliases: ["/settings/memory-import"] },
  workboard: { path: "/workboard" },
  worktrees: { path: "/worktrees", aliases: ["/settings/worktrees"] },
  sessions: { path: "/sessions", aliases: ["/settings/sessions"] },
  usage: { path: "/usage" },
  debug: { path: "/debug" },
  logs: { path: "/logs" },
  "skill-workshop": { path: "/skills/workshop" },
  skills: { path: "/skills" },
  plugins: { path: "/settings/plugins" },
  // Automations is the product name; /cron stays as a legacy alias for
  // pre-rename bookmarks and deep links.
  cron: { path: "/automations", aliases: ["/cron"] },
  tasks: { path: "/tasks" },
  devices: { path: "/settings/devices", aliases: ["/nodes"] },
  "cloud-workers": { path: "/settings/cloud-workers" },
  plugin: { path: "/plugin" },
} as const;

export type RouteId = keyof typeof APP_ROUTE_DEFINITIONS;
export const APP_ROUTE_IDS = Object.keys(APP_ROUTE_DEFINITIONS) as RouteId[];
const APP_ROUTE_PATHS: string[] = [];
const ROUTE_ID_BY_PATH = new Map<string, RouteId>();
// Static paths and aliases share one prepared index; earlier declarations keep priority.
for (const routeId of APP_ROUTE_IDS) {
  const definition = APP_ROUTE_DEFINITIONS[routeId];
  const paths: readonly string[] =
    "aliases" in definition ? [definition.path, ...definition.aliases] : [definition.path];
  for (const path of paths) {
    const normalizedPath = normalizePath(path);
    APP_ROUTE_PATHS.push(normalizedPath);
    if (!ROUTE_ID_BY_PATH.has(normalizedPath)) {
      ROUTE_ID_BY_PATH.set(normalizedPath, routeId);
    }
  }
}

export function isRouteId(routeId: string): routeId is RouteId {
  return Object.hasOwn(APP_ROUTE_DEFINITIONS, routeId);
}

// Single source for page definitions: ui/src/pages/*/route.ts spreads this
// into definePage so router matching can never drift from the table that
// drives routeIdFromPath and base-path inference.
export function routePageSpec<Id extends RouteId>(
  routeId: Id,
): { id: Id; path: string; aliases?: readonly string[] } {
  return { id: routeId, ...APP_ROUTE_DEFINITIONS[routeId] };
}

export { normalizeBasePath };

export function pathForRoute(routeId: RouteId, basePath = ""): string {
  return `${normalizeBasePath(basePath)}${APP_ROUTE_DEFINITIONS[routeId].path}`;
}

function routePathSuffix(pathname: string, routeId: RouteId, basePath: string): string | null {
  const normalizedPath = normalizePath(pathname);
  const routePath = pathForRoute(routeId, basePath);
  if (normalizedPath === routePath) {
    return "";
  }
  const prefix = `${routePath}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) || null : null;
}

/** Legacy person query accepted by existing Activity links. */
export const ACTIVITY_PERSON_PARAM = "person";
const ACTIVITY_PERSON_SHORT_REF_RE = /(?:^|-)([0-9a-f]{8,32})$/u;

function isProfileUuid(id: string): boolean {
  return id.length === 36 && SESSION_UUID_SUFFIX_RE.test(id);
}

/** Activity feed scoped to one person, for every surface that shows an identity. */
export function activityPersonLocation(
  personId: string,
  basePath = "",
  label?: string,
  minimumRefLength = 12,
): { pathname: string; search: string; href: string } {
  const uuid = isProfileUuid(personId);
  const slug = takeGraphemes(normalizeAtHashSlug(label), 48).replace(/-+$/u, "");
  const reference = uuid
    ? `${slug ? `${slug}-` : ""}${personId.replaceAll("-", "").slice(0, minimumRefLength).toLowerCase()}`
    : personId;
  // A decorative name must not turn its short reference into another exact UUID.
  let encodedReference = encodeURIComponent(
    isProfileUuid(reference) ? `person-${reference}` : reference,
  ).replaceAll(".", "%2E");
  // Retained protocol identities can be literal strings; escape their short-ref delimiter.
  if (!uuid) {
    encodedReference = encodedReference.replace(/-(?=[0-9a-f]{8,32}$)/u, "%2D");
  }
  const pathname = `${pathForRoute("activity", basePath)}/${encodedReference}`;
  return { pathname, search: "", href: pathname };
}

export function activityPersonFromPath(pathname: string, basePath = ""): string | null {
  const reference = routePathSuffix(pathname, "activity", basePath);
  if (!reference || reference.includes("/")) {
    return null;
  }
  try {
    const personId = decodeURIComponent(reference);
    if (!personId.trim() || personId === "." || personId === "..") {
      return null;
    }
    // A full UUID is an exact identifier; its final group is not a short prefix.
    return isProfileUuid(personId)
      ? personId
      : (reference.match(ACTIVITY_PERSON_SHORT_REF_RE)?.[1] ?? personId);
  } catch {
    return null;
  }
}

export function pathForWorkboardBoard(boardId: string, basePath = ""): string {
  if (!isValidWorkboardBoardId(boardId)) {
    throw new Error("Invalid Workboard board id.");
  }
  const encodedBoardId = encodeURIComponent(boardId).replaceAll(".", "%2E");
  return `${pathForRoute("workboard", basePath)}/${encodedBoardId}`;
}

export function pathForAgentPanel(
  agentId: string,
  panel: AgentsPanel | null = null,
  basePath = "",
): string {
  if (!agentId || agentId.includes("/") || agentId === "." || agentId === "..") {
    throw new Error("Invalid agent id for a route path.");
  }
  const encodedAgentId = encodeURIComponent(agentId).replaceAll(".", "%2E");
  const agentPath = `${pathForRoute("agents", basePath)}/${encodedAgentId}`;
  return panel ? `${agentPath}/${panel}` : agentPath;
}

export function agentRouteFromPath(pathname: string, basePath = ""): AgentRoutePath | null {
  const suffix = routePathSuffix(pathname, "agents", basePath);
  if (!suffix) {
    return null;
  }
  const segments = suffix.split("/");
  if (segments.length > 2 || !segments[0]) {
    return null;
  }
  let agentId: string;
  try {
    agentId = decodeURIComponent(segments[0]);
  } catch {
    return null;
  }
  if (!agentId || agentId.includes("/") || agentId === "." || agentId === "..") {
    return null;
  }
  const rawPanel = segments[1] ?? null;
  const panelSegment = rawPanel && isAgentsPanel(rawPanel) ? rawPanel : null;
  return {
    agentId,
    panel: panelSegment ?? DEFAULT_AGENT_PANEL,
    panelSegment,
    invalidPanel: rawPanel !== null && panelSegment === null,
  };
}

export function pathForMemoryTab(tab: MemoryRouteTab, basePath = ""): string {
  const memoryPath = pathForRoute("memory", basePath);
  return tab === "overview" ? memoryPath : `${memoryPath}/${tab}`;
}

export function memoryTabFromPath(pathname: string, basePath = ""): MemoryRouteTab | null {
  const segment = routePathSuffix(pathname, "memory", basePath);
  if (segment === "") {
    return "overview";
  }
  return segment === "memories" || segment === "dreams" || segment === "settings" ? segment : null;
}

export function pathForPluginsHubTab(tab: PluginsHubRouteTab, basePath = ""): string {
  const pluginsPath = pathForRoute("plugins", basePath);
  return tab === "installed" ? pluginsPath : `${pluginsPath}/discover`;
}

export function pluginsHubTabFromPath(pathname: string, basePath = ""): PluginsHubRouteTab | null {
  const segment = routePathSuffix(pathname, "plugins", basePath);
  return segment === "" ? "installed" : segment === "discover" ? "discover" : null;
}

export function isSessionRouteId(routeId: string | null | undefined): routeId is BoardFace {
  return routeId === "chat" || routeId === "dashboard";
}

export function sessionRouteNamespaceFromPath(pathname: string, basePath = ""): BoardFace | null {
  const normalizedPath = normalizePath(pathname);
  const normalizedBasePath = normalizeBasePath(basePath);
  if (
    normalizedBasePath &&
    normalizedPath !== normalizedBasePath &&
    !normalizedPath.startsWith(`${normalizedBasePath}/`)
  ) {
    return null;
  }
  const routePath = normalizedPath.slice(normalizedBasePath.length);
  if (routePath.startsWith("/chat/")) {
    return "chat";
  }
  if (routePath.startsWith("/dashboard/")) {
    return "dashboard";
  }
  // The shared matcher reserves every built-in route and document namespace.
  const catalogShare = matchControlUiCatalogSharePath({
    pathname: normalizedPath,
    basePath: normalizedBasePath,
  });
  return catalogShare ? "chat" : null;
}

export function workboardBoardIdFromPath(pathname: string, basePath = ""): string | null {
  const encodedBoardId = routePathSuffix(pathname, "workboard", basePath);
  if (!encodedBoardId || encodedBoardId.includes("/")) {
    return null;
  }
  try {
    const boardId = decodeURIComponent(encodedBoardId);
    return isValidWorkboardBoardId(boardId) ? boardId : null;
  } catch {
    return null;
  }
}

function dynamicRouteIdFromPath(pathname: string, basePath = ""): RouteId | null {
  if (agentRouteFromPath(pathname, basePath)) {
    return "agents";
  }
  if (activityPersonFromPath(pathname, basePath)) {
    return "activity";
  }
  if (workboardBoardIdFromPath(pathname, basePath)) {
    return "workboard";
  }
  if (memoryTabFromPath(pathname, basePath)) {
    return "memory";
  }
  if (pluginsHubTabFromPath(pathname, basePath)) {
    return "plugins";
  }
  return sessionRouteNamespaceFromPath(pathname, basePath);
}

export function routeIdFromPath(pathname: string, basePath = ""): RouteId | null {
  const normalizedPath = normalizePath(pathname);
  const normalizedBasePath = normalizeBasePath(basePath);
  const isWithinBasePath =
    !normalizedBasePath ||
    normalizedPath === normalizedBasePath ||
    normalizedPath.startsWith(`${normalizedBasePath}/`);
  if (!isWithinBasePath) {
    return null;
  }
  const routePath = normalizedBasePath
    ? normalizedPath.slice(normalizedBasePath.length) || "/"
    : normalizedPath;
  // uirouter matches static paths case-insensitively (pathKey lowercases), so
  // this pre-gate must too — otherwise /Usage is rewritten to /chat before the
  // router, which would have matched it, ever starts.
  return (
    ROUTE_ID_BY_PATH.get(routePath.toLowerCase()) ??
    dynamicRouteIdFromPath(normalizedPath, normalizedBasePath)
  );
}

// A candidate mount base that is a registered route ("/custodian"), or that
// sits at or below a multi-segment route namespace ("/settings", including
// "/settings/other"), is really a root-mounted deep link whose suffix happens
// to match a route path or alias. Descendants of leaf routes stay valid mount
// directories so "/apps/openclaw" keeps working. Inference is a last-resort
// fallback for pages served without the injected base path (vite dev, static
// hosting); accepted tradeoff: namespaces nested under a real mount prefix
// ("/ui/settings/other/config") are not rescued here.
function isRouteOwnedBasePath(basePath: string): boolean {
  if (APP_ROUTE_PATHS.includes(basePath)) {
    return true;
  }
  const segments = basePath.split("/").filter(Boolean);
  for (let count = 1; count <= segments.length; count += 1) {
    const ancestor = `/${segments.slice(0, count).join("/")}`;
    if (APP_ROUTE_PATHS.some((path) => path.startsWith(`${ancestor}/`))) {
      return true;
    }
  }
  return false;
}

export function inferBasePathFromPathname(pathname: string): string {
  const focusBasePath = inferControlUiFocusBasePath(pathname);
  if (focusBasePath !== null) {
    return focusBasePath;
  }
  const isMountRoot = pathname.trim().endsWith("/");
  const normalizedPath = normalizePath(pathname);
  if (normalizedPath.toLowerCase().endsWith("/index.html")) {
    return normalizeBasePath(normalizedPath.slice(0, -"/index.html".length));
  }
  if (normalizedPath === "/") {
    return "";
  }
  const segments = normalizedPath.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = `/${segments.slice(index).join("/")}`;
    const routePath = ROUTE_ID_BY_PATH.has(candidate) ? candidate : undefined;
    const documentRoutePath = Object.values(CONTROL_UI_DOCUMENT_ROUTE_PATHS).find(
      (path) => candidate === path || candidate.startsWith(`${path}/`),
    );
    const dynamicRouteId = dynamicRouteIdFromPath(candidate);
    if (!routePath && !documentRoutePath && !dynamicRouteId) {
      continue;
    }
    const previousSegment = segments[index - 1];
    const dynamicRoutePath =
      documentRoutePath ?? (dynamicRouteId ? APP_ROUTE_DEFINITIONS[dynamicRouteId].path : null);
    const firstRouteSegment = (routePath ?? dynamicRoutePath ?? "").split("/")[1];
    if (index === 0 || previousSegment === firstRouteSegment) {
      return "";
    }
    const basePath = `/${segments.slice(0, index).join("/")}`;
    // Mis-inferring a route-owned base ("/settings/config" -> "/settings" via
    // the "/config" alias) rescopes stored gateway settings and asset URLs, so
    // a connected browser deep-links straight into the login gate.
    return isRouteOwnedBasePath(basePath) ? "" : basePath;
  }
  if (!isMountRoot || segments.length === 0) {
    return "";
  }
  const mountRootBase = `/${segments.join("/")}`;
  return isRouteOwnedBasePath(mountRootBase) ? "" : mountRootBase;
}

export function locationForRoute(routeId: RouteId, basePath: string): RouteLocation {
  return {
    pathname: pathForRoute(routeId, basePath),
    search: "",
    hash: "",
  };
}
