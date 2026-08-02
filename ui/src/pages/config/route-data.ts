import type { RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_MEMORY_PATH_PARAM } from "../../app-route-paths.ts";

export type ConfigRouteData = {
  pathname: string;
  search: string;
  hash: string;
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

export function configRouteData(location: RouteLocation): ConfigRouteData {
  const searchParams = new URLSearchParams(location.search);
  const pathname = searchParams.get(INTERNAL_MEMORY_PATH_PARAM) ?? location.pathname;
  searchParams.delete(INTERNAL_MEMORY_PATH_PARAM);
  const search = searchParams.toString();
  const section = searchParams.get("section")?.trim() || null;
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
    section,
    advanced: searchParams.get("advanced") === "1",
    tab: searchParams.get("tab")?.trim() || null,
    targetBlockId: configTargetIdFromHash(location.hash),
  };
}
