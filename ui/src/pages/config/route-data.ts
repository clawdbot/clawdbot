import type { RouteLocation } from "@openclaw/uirouter";

export type ConfigRouteData = {
  section: string | null;
  advanced: boolean;
  /** Raw `?tab=`; curated hub pages normalize it against their own tab set. */
  tab: string | null;
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
  const searchParams = new URLSearchParams(location.search);
  const section = searchParams.get("section")?.trim() || null;
  return {
    section,
    advanced: searchParams.get("advanced") === "1",
    tab: searchParams.get("tab")?.trim() || null,
    targetBlockId: configTargetIdFromHash(location.hash),
  };
}
