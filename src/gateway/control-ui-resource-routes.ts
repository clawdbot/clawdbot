import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  CONTROL_UI_USER_AVATAR_PATH_PREFIX,
  CONTROL_UI_USER_AVATAR_PATH_SUFFIX,
} from "./control-ui-user-avatar-route.js";

const CONTROL_UI_RESOURCE_ROUTES = {
  agentAvatar: { prefix: "/avatar", suffix: "" },
  catalogIcon: { prefix: "/__openclaw__/catalog-icon", suffix: "" },
  channelAvatar: { prefix: "/__openclaw__/channel-avatar", suffix: "" },
  linkFavicon: { prefix: "/__openclaw__/link-favicon", suffix: "" },
  pluginIcon: { prefix: "/__openclaw__/plugin-icon", suffix: "" },
  userAvatar: {
    prefix: CONTROL_UI_USER_AVATAR_PATH_PREFIX.slice(0, -1),
    suffix: CONTROL_UI_USER_AVATAR_PATH_SUFFIX,
  },
  workspaceIcon: { prefix: "/__openclaw__/workspace-icon", suffix: "" },
} as const;

export type ControlUiResourceRoute = keyof typeof CONTROL_UI_RESOURCE_ROUTES;
type ControlUiResourcePathMatch = { matched: false } | { matched: true; value: string | null };

/** Builds one canonical, encoded Control UI resource path. */
export function buildControlUiResourcePath(
  route: ControlUiResourceRoute,
  basePath: string | null | undefined,
  value: string,
): string {
  const definition = CONTROL_UI_RESOURCE_ROUTES[route];
  return `${normalizeControlUiBasePath(basePath)}${definition.prefix}/${encodeURIComponent(value)}${definition.suffix}`;
}

/** Parses one exact encoded route segment while retaining malformed-route ownership. */
export function parseControlUiResourcePath(
  route: ControlUiResourceRoute,
  pathname: string | null | undefined,
  basePath?: string | null,
): ControlUiResourcePathMatch {
  if (!pathname) {
    return { matched: false };
  }
  const definition = CONTROL_UI_RESOURCE_ROUTES[route];
  const prefix = `${normalizeControlUiBasePath(basePath)}${definition.prefix}/`;
  if (!pathname.startsWith(prefix)) {
    return { matched: false };
  }
  const remainder = pathname.slice(prefix.length);
  if (!remainder.endsWith(definition.suffix)) {
    return { matched: true, value: null };
  }
  const encoded = definition.suffix ? remainder.slice(0, -definition.suffix.length) : remainder;
  if (!encoded || encoded.includes("/")) {
    return { matched: true, value: null };
  }
  try {
    return { matched: true, value: decodeURIComponent(encoded) || null };
  } catch {
    return { matched: true, value: null };
  }
}

export function parseControlUiUserAvatarPath(
  pathname: string,
  basePath: string,
): ControlUiResourcePathMatch {
  const canonical = parseControlUiResourcePath("userAvatar", pathname);
  if (canonical.matched) {
    return canonical;
  }
  return normalizeControlUiBasePath(basePath)
    ? parseControlUiResourcePath("userAvatar", pathname, basePath)
    : canonical;
}

function matchControlUiResourcePath(
  route: ControlUiResourceRoute,
  pathname: string | null | undefined,
  basePath?: string | null,
): string | undefined {
  const parsed = parseControlUiResourcePath(route, pathname, basePath);
  return parsed.matched && parsed.value ? parsed.value : undefined;
}

/** Builds the authenticated conversation-avatar URL for a session. */
export function buildControlUiChannelAvatarUrl(
  basePath: string,
  sessionKey: string,
  revision: string,
): string {
  // The revision keys client-side blob/404 caches: a replaced or restored
  // backing image must change the URL or mounted rows stay stale forever.
  const path = buildControlUiResourcePath("channelAvatar", basePath, sessionKey);
  return `${path}?v=${encodeURIComponent(revision)}`;
}

type ControlUiResourceUrlMatch = {
  value: string;
  search: string;
  hash: string;
};

/** Matches an exact root-relative same-origin resource URL without parser reinterpretation. */
export function matchControlUiResourceUrl(
  route: ControlUiResourceRoute,
  value: string,
  basePath?: string | null,
): ControlUiResourceUrlMatch | undefined {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return undefined;
  }
  try {
    const origin = "http://openclaw.invalid";
    const parsed = new URL(value, origin);
    if (parsed.origin !== origin || `${parsed.pathname}${parsed.search}${parsed.hash}` !== value) {
      return undefined;
    }
    const routeValue = matchControlUiResourcePath(route, parsed.pathname, basePath);
    return routeValue === undefined
      ? undefined
      : { value: routeValue, search: parsed.search, hash: parsed.hash };
  } catch {
    return undefined;
  }
}
