import type { RouteLocation } from "@openclaw/uirouter";
import { INTERNAL_MEMORY_PATH_PARAM } from "../../app-route-paths.ts";

export const MODEL_SETTINGS_TARGET_IDS = { behavior: "settings-model-behavior" } as const;

export const APPEARANCE_SETTINGS_TARGET_IDS = {
  language: "settings-language",
  theme: "settings-appearance-theme",
  accent: "settings-appearance-accent",
  textSize: "settings-appearance-text-size",
  sidebar: "settings-appearance-sidebar",
  chat: "settings-appearance-chat",
  connection: "settings-appearance-connection",
} as const;

const appearanceSettingsRouteTarget = (targetId: string) =>
  ({ routeId: "appearance", search: "?section=__appearance__", hash: `#${targetId}` }) as const;

export const SETTINGS_ROUTE_TARGETS = {
  modelBehavior: {
    routeId: "model-providers",
    hash: `#${MODEL_SETTINGS_TARGET_IDS.behavior}`,
  },
  appearanceLanguage: appearanceSettingsRouteTarget(APPEARANCE_SETTINGS_TARGET_IDS.language),
  appearanceSidebar: appearanceSettingsRouteTarget(APPEARANCE_SETTINGS_TARGET_IDS.sidebar),
} as const;

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
