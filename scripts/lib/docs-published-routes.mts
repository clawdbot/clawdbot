import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Normalizes a docs route by stripping query, hash, and edge slashes. */
export function normalizeRoute(p: string) {
  const withoutFragment = p.split("#")[0] ?? "";
  const withoutQuery = withoutFragment.split("?")[0] ?? "";
  const stripped = withoutQuery.replace(/^\/+|\/+$/g, "");
  return stripped ? `/${stripped}` : "/";
}

export function addRoute(routes: Set<string>, slug: string) {
  const route = normalizeRoute(slug);
  routes.add(route);
  if (slug.endsWith("/index")) {
    routes.add(normalizeRoute(slug.slice(0, -"/index".length)));
  }
}

export function collectNavPageEntries(node: unknown): string[] {
  const entries: string[] = [];
  if (Array.isArray(node)) {
    for (const item of node) {
      entries.push(...collectNavPageEntries(item));
    }
    return entries;
  }

  if (!isRecord(node)) {
    return entries;
  }

  const record = node;
  if (Array.isArray(record.pages)) {
    for (const page of record.pages) {
      if (typeof page === "string") {
        entries.push(page);
      } else {
        entries.push(...collectNavPageEntries(page));
      }
    }
  }

  for (const value of Object.values(record)) {
    if (value !== record.pages) {
      entries.push(...collectNavPageEntries(value));
    }
  }

  return entries;
}

// The docs publisher mirrors ClawHub; its navigation entries declare the public routes.
export function collectMirroredDocsRoutes(navigation: unknown): Set<string> {
  const routes = new Set<string>();
  for (const page of collectNavPageEntries(navigation)) {
    const route = normalizeRoute(page);
    if (route === "/clawhub" || route.startsWith("/clawhub/")) {
      addRoute(routes, page);
    }
  }
  return routes;
}
