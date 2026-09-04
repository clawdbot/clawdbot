import { normalizeBasePath } from "../app-route-paths.ts";

// Gateway startup owns connection context; avatar presentation stays in lazy views.
let appGatewayOrigin: string | null = null;
let appGatewayResourceBasePath = "";
let appGatewayAuthTokens: readonly string[] = [];
let gatewayRequests = new AbortController();
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
    authTokens: appGatewayAuthTokens,
  };
}

/** Recover rejected credentials only within the current Gateway and one request deadline. */
export async function fetchGatewayContextResource(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const origin = appGatewayOrigin ?? globalThis.location?.origin ?? "http://localhost";
  if (new URL(url, origin).origin !== origin) {
    throw new Error("Resource must belong to the connected Gateway");
  }
  const signal = AbortSignal.any([gatewayRequests.signal, AbortSignal.timeout(timeoutMs)]);
  for (const token of appGatewayAuthTokens.length ? appGatewayAuthTokens : [""]) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      credentials: "include",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal,
    });
    if (signal.aborted || response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      signal.throwIfAborted();
      continue;
    }
    return response;
  }
  throw new Error("Gateway credentials rejected");
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
  authTokens: readonly string[] = [],
  resourceBasePath = "",
): void {
  const nextOrigin = toHttpOrigin(gatewayUrl);
  const documentOrigin = globalThis.location?.origin;
  const nextResourceBasePath =
    nextOrigin && documentOrigin === nextOrigin ? normalizeBasePath(resourceBasePath) : "";
  if (
    appGatewayOrigin !== nextOrigin ||
    appGatewayResourceBasePath !== nextResourceBasePath ||
    appGatewayAuthTokens.length !== authTokens.length ||
    appGatewayAuthTokens.some((token, index) => token !== authTokens[index])
  ) {
    // A replaced credential context must not finish an old fetch or advance
    // its rejected credential to another saved secret.
    gatewayRequests.abort();
    gatewayRequests = new AbortController();
    for (const reset of gatewayContextResets) {
      reset();
    }
  }
  appGatewayOrigin = nextOrigin;
  appGatewayResourceBasePath = nextResourceBasePath;
  appGatewayAuthTokens = [...authTokens];
}
