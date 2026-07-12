import { normalizeRouteBasePath, normalizeRoutePath } from "@openclaw/uirouter";
import type { RouteLocation } from "@openclaw/uirouter";

const APP_ROUTE_DEFINITIONS = {
  chat: { path: "/chat" },
  "new-session": { path: "/new" },
  activity: { path: "/activity" },
  agents: { path: "/agents" },
  channels: { path: "/settings/channels", aliases: ["/channels"] },
  connection: { path: "/settings/connection" },
  config: { path: "/settings/general", aliases: ["/config"] },
  profile: { path: "/settings/profile", aliases: ["/profile"] },
  communications: { path: "/settings/communications", aliases: ["/communications"] },
  appearance: { path: "/settings/appearance", aliases: ["/appearance"] },
  automation: { path: "/settings/automation", aliases: ["/automation"] },
  mcp: { path: "/settings/mcp", aliases: ["/mcp"] },
  infrastructure: { path: "/settings/infrastructure", aliases: ["/infrastructure"] },
  about: { path: "/settings/about" },
  "ai-agents": { path: "/settings/ai-agents", aliases: ["/ai-agents"] },
  "model-providers": { path: "/settings/model-providers", aliases: ["/model-providers"] },
  workboard: { path: "/workboard" },
  worktrees: { path: "/settings/worktrees", aliases: ["/worktrees"] },
  sessions: { path: "/sessions" },
  usage: { path: "/usage" },
  debug: { path: "/debug" },
  logs: { path: "/logs" },
  "skill-workshop": { path: "/skills/workshop" },
  skills: { path: "/skills" },
  plugins: { path: "/settings/plugins" },
  cron: { path: "/cron" },
  tasks: { path: "/tasks" },
  nodes: { path: "/nodes" },
  plugin: { path: "/plugin" },
} as const;

export type RouteId = keyof typeof APP_ROUTE_DEFINITIONS;
export const APP_ROUTE_IDS = Object.keys(APP_ROUTE_DEFINITIONS) as RouteId[];

export function isRouteId(routeId: string): routeId is RouteId {
  return routeId in APP_ROUTE_DEFINITIONS;
}

export function normalizeBasePath(basePath: string): string {
  return normalizeRouteBasePath(basePath);
}

export function normalizePath(path: string): string {
  return normalizeRoutePath(path);
}

export function pathForRoute(routeId: RouteId, basePath = ""): string {
  const normalizedBasePath = normalizeBasePath(basePath);
  const path = APP_ROUTE_DEFINITIONS[routeId].path;
  return normalizedBasePath ? `${normalizedBasePath}${path}` : path;
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
  for (const routeId of APP_ROUTE_IDS) {
    const definition = APP_ROUTE_DEFINITIONS[routeId];
    const paths: readonly string[] =
      "aliases" in definition ? [definition.path, ...definition.aliases] : [definition.path];
    if (paths.some((candidate) => normalizePath(candidate) === routePath)) {
      return routeId;
    }
  }
  return null;
}

export function inferBasePathFromPathname(pathname: string): string {
  const isMountRoot = pathname.trim().endsWith("/");
  const normalizedPath = normalizePath(pathname);
  if (normalizedPath.toLowerCase().endsWith("/index.html")) {
    return normalizeBasePath(normalizedPath.slice(0, -"/index.html".length));
  }
  if (normalizedPath === "/") {
    return "";
  }
  const segments = normalizedPath.split("/").filter(Boolean);
  const routePaths = APP_ROUTE_IDS.flatMap((routeId) => {
    const definition = APP_ROUTE_DEFINITIONS[routeId];
    const paths: string[] = [definition.path];
    if ("aliases" in definition) {
      paths.push(...definition.aliases);
    }
    return paths;
  });
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = `/${segments.slice(index).join("/")}`;
    const routePath = routePaths.find((path) => normalizePath(path) === candidate);
    if (!routePath) {
      continue;
    }
    const previousSegment = segments[index - 1];
    const firstRouteSegment = routePath.split("/").find(Boolean);
    if (index > 0 && previousSegment === firstRouteSegment && candidate === routePath) {
      return "";
    }
    return index ? `/${segments.slice(0, index).join("/")}` : "";
  }
  return isMountRoot && segments.length ? `/${segments.join("/")}` : "";
}

export function locationForRoute(routeId: RouteId, basePath: string): RouteLocation {
  return {
    pathname: pathForRoute(routeId, basePath),
    search: "",
    hash: "",
  };
}
