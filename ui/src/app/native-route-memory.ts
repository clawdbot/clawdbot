import { isRouteId, type RouteId } from "../app-routes.ts";
import { isNativeWebChromeHost } from "./native-web-chrome.ts";

// localStorage is per-origin: a remote tunnel recreated on a new ephemeral
// port cannot read routes stored by the old origin and falls back to the
// default route. Accepted — local gateways (the common case) have stable
// origins, and the degraded path matches pre-route-memory behavior.
const NATIVE_LAST_ROUTE_KEY = "openclaw.native.lastRoute";

type StoredNativeRoute = {
  routeId: RouteId;
  search: string;
};

// The `localStorage` getter itself throws on opaque origins or when
// persistence is blocked, so it must resolve inside a guard, not as a default
// argument evaluated before the function body.
function resolveStorage(storage?: Storage): Storage | null {
  try {
    return storage ?? localStorage;
  } catch {
    return null;
  }
}

function readStoredRoute(
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): StoredNativeRoute | null {
  const store = nativeHost ? resolveStorage(storage) : null;
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(NATIVE_LAST_ROUTE_KEY);
    if (raw === null) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<StoredNativeRoute>;
    if (
      typeof value.routeId === "string" &&
      isRouteId(value.routeId) &&
      typeof value.search === "string"
    ) {
      return { routeId: value.routeId, search: value.search };
    }
    store.removeItem(NATIVE_LAST_ROUTE_KEY);
  } catch {
    try {
      store.removeItem(NATIVE_LAST_ROUTE_KEY);
    } catch {
      // Storage may be unavailable for this origin; route memory stays optional.
    }
  }
  return null;
}

// One-shot action params (palette slash-command drafts) must not replay on a
// later launch; navigation state like ?session= is exactly what memory keeps.
const TRANSIENT_SEARCH_PARAMS = ["draft"];

function restorableSearch(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of TRANSIENT_SEARCH_PARAMS) {
    params.delete(name);
  }
  const filtered = params.toString();
  return filtered ? `?${filtered}` : "";
}

export function persistRoute(
  routeId: RouteId,
  search: string,
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): void {
  const store = nativeHost ? resolveStorage(storage) : null;
  if (!store) {
    return;
  }
  try {
    store.setItem(
      NATIVE_LAST_ROUTE_KEY,
      JSON.stringify({ routeId, search: restorableSearch(search) }),
    );
  } catch {
    // Storage may be unavailable for this origin; navigation must still work.
  }
}

function shouldRestore(routeId: RouteId, search: string, nativeHost: boolean): boolean {
  return nativeHost && routeId === "chat" && search === "";
}

/**
 * Returns the stored route to restore, or null when the boot route is an
 * explicit deep link, matches the stored route, or no valid entry exists.
 */
export function considerRouteRestore(
  routeId: RouteId,
  search: string,
  storage?: Storage,
  nativeHost = isNativeWebChromeHost(),
): StoredNativeRoute | null {
  if (!shouldRestore(routeId, search, nativeHost)) {
    return null;
  }
  const stored = readStoredRoute(storage, nativeHost);
  if (!stored || (stored.routeId === routeId && stored.search === search)) {
    return null;
  }
  return stored;
}
