import { parseBrowserHttpUrl } from "openclaw/plugin-sdk/browser-config";
/**
 * Browser profile allocation helpers.
 *
 * Validates profile names and allocates CDP ports/colors for newly persisted
 * browser profiles.
 */
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";

/**
 * CDP port allocation for browser profiles.
 *
 * Default port range: 18800-18899 (100 profiles max)
 * Ports are allocated once at profile creation and persisted in config.
 * Multi-instance: callers may pass an explicit range to avoid collisions.
 *
 * Reserved ports (do not use for CDP):
 *   18789 - Gateway WebSocket
 *   18790 - Bridge
 *   18791 - Browser control server
 *   18792-18799 - Reserved for future one-off services (canvas at 18793)
 */

/** Default first CDP port for browser profiles. */
export const CDP_PORT_RANGE_START = 18800;
/** Default last CDP port for browser profiles. */
export const CDP_PORT_RANGE_END = 18899;
const MAX_TCP_PORT = 65_535;

const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/** Return true when a profile name matches the supported config key format. */
export function isValidProfileName(name: string): boolean {
  if (!name || name.length > 64) {
    return false;
  }
  return PROFILE_NAME_REGEX.test(name);
}

/** Allocate the first unused CDP port in the configured range. */
export function allocateCdpPort(
  usedPorts: Set<number>,
  range?: { start: number; end: number },
): number | null {
  const start = range?.start ?? CDP_PORT_RANGE_START;
  const end = range?.end ?? CDP_PORT_RANGE_END;
  if (!isValidTcpPort(start) || !isValidTcpPort(end)) {
    return null;
  }
  if (start > end) {
    return null;
  }
  for (let port = start; port <= end; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  return null;
}

function isValidTcpPort(port: number): boolean {
  return Number.isSafeInteger(port) && port > 0 && port <= MAX_TCP_PORT;
}

/** Extract currently used CDP ports from profile config. */
export function getUsedPorts(
  profiles: Record<string, { cdpPort?: number; cdpUrl?: string }> | undefined,
): Set<number> {
  if (!profiles) {
    return new Set();
  }
  const used = new Set<number>();
  for (const profile of Object.values(profiles)) {
    if (typeof profile.cdpPort === "number" && isValidTcpPort(profile.cdpPort)) {
      used.add(profile.cdpPort);
      continue;
    }
    const rawUrl = profile.cdpUrl?.trim();
    if (!rawUrl) {
      continue;
    }
    try {
      used.add(parseBrowserHttpUrl(rawUrl, "browser.profiles.*.cdpUrl").port);
    } catch {
      // ignore invalid URLs
    }
  }
  return used;
}

/** Default browser profile color palette. */
export const PROFILE_COLORS = [
  "#FF4500", // Orange-red (openclaw default)
  "#0066CC", // Blue
  "#00AA00", // Green
  "#9933FF", // Purple
  "#FF6699", // Pink
  "#00CCCC", // Cyan
  "#FF9900", // Orange
  "#6666FF", // Indigo
  "#CC3366", // Magenta
  "#339966", // Teal
];

/** Allocate the first unused profile color, cycling when all are used. */
export function allocateColor(usedColors: Set<string>): string {
  // Find first unused color from palette
  for (const color of PROFILE_COLORS) {
    if (!usedColors.has(color.toUpperCase())) {
      return color;
    }
  }
  // All colors used, cycle based on count
  const index = usedColors.size % PROFILE_COLORS.length;
  return expectDefined(PROFILE_COLORS[index], "cycled browser color palette index");
}

/** Extract currently used profile colors from profile config. */
export function getUsedColors(
  profiles: Record<string, { color: string }> | undefined,
): Set<string> {
  if (!profiles) {
    return new Set();
  }
  return new Set(Object.values(profiles).map((p) => p.color.toUpperCase()));
}
