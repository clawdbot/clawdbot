import { normalizeBasePath } from "../app-route-paths.ts";

// Gateway startup owns connection context; avatar presentation stays in lazy views.
let appGatewayOrigin: string | null = null;
let appGatewayResourceBasePath = "";
let appGatewayAuthHeader: string | null = null;
// More than one cache is keyed by the Gateway HTTP context (avatars,
// geolocation), so every subscriber must be notified on a switch. A single slot
// would silently drop whichever registered first.
const gatewayContextResets = new Set<() => void>();

export function registerAvatarGatewayReset(reset: () => void): void {
  gatewayContextResets.add(reset);
}

export function readAvatarGatewayContext() {
  return {
    origin: appGatewayOrigin,
    resourceBasePath: appGatewayResourceBasePath,
    authHeader: appGatewayAuthHeader,
  };
}

function toHttpOrigin(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const scheme =
      parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    return `${scheme}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** Keeps avatar routes, credentials, and cached images scoped to the current gateway. */
export function setAvatarGatewayOrigin(
  gatewayUrl: string | null | undefined,
  authHeader: string | null = null,
  resourceBasePath = "",
): void {
  const nextOrigin = toHttpOrigin(gatewayUrl);
  const documentOrigin = globalThis.location?.origin;
  const nextResourceBasePath =
    nextOrigin && documentOrigin === nextOrigin ? normalizeBasePath(resourceBasePath) : "";
  const nextAuthHeader = authHeader?.trim() || null;
  if (
    appGatewayOrigin !== nextOrigin ||
    appGatewayResourceBasePath !== nextResourceBasePath ||
    appGatewayAuthHeader !== nextAuthHeader
  ) {
    for (const reset of gatewayContextResets) {
      reset();
    }
  }
  appGatewayOrigin = nextOrigin;
  appGatewayResourceBasePath = nextResourceBasePath;
  appGatewayAuthHeader = nextAuthHeader;
}
