import type { RouteLocation } from "@openclaw/uirouter";

export type ConfigRouteData = {
  section: string | null;
  targetBlockId: string | null;
};

export function configTargetIdFromHash(hash: string): string | null {
  if (!hash) {
    return null;
  }
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

export function configRouteData(location: Pick<RouteLocation, "search" | "hash">): ConfigRouteData {
  const section = new URLSearchParams(location.search).get("section")?.trim() || null;
  return {
    section,
    targetBlockId: configTargetIdFromHash(location.hash),
  };
}
