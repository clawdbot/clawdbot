import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { inferBasePathFromPathname, normalizeBasePath } from "../app-route-paths.ts";
import { isNativeEmbedHost } from "./native-web-chrome.ts";

type WindowWithControlUiBasePath = Window &
  typeof globalThis & {
    [key: string]: unknown;
  };

function readControlUiResourceBasePath(): string | null {
  const windowValue =
    typeof window === "undefined"
      ? undefined
      : (window as WindowWithControlUiBasePath)["__OPENCLAW_CONTROL_UI_BASE_PATH__"];
  const value =
    typeof windowValue === "string"
      ? windowValue
      : typeof document === "undefined"
        ? null
        : document.documentElement.getAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
  return value === null ? null : normalizeBasePath(value);
}

export function resolveControlUiPaths(pathname: string) {
  const resourceBasePath = readControlUiResourceBasePath();
  const basePath = resourceBasePath || inferBasePathFromPathname(pathname);
  return [basePath, resourceBasePath ?? basePath] as const;
}

function readLocation(): RouteLocation {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  };
}

function writeLocation(location: RouteLocation) {
  return `${location.pathname}${location.search}${location.hash}`;
}

function nativeEmbedHistoryDepth(): number {
  const state: unknown = window.history.state;
  if (state && typeof state === "object" && "openclawNativeEmbedDepth" in state) {
    const depth = state.openclawNativeEmbedDepth;
    if (typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0) {
      return depth;
    }
  }
  return 0;
}

export function canGoBackInNativeEmbed(): boolean {
  return nativeEmbedHistoryDepth() > 0;
}

export function createBrowserHistory(): RouterHistory {
  const embedded = isNativeEmbedHost();
  const listeners = new Set<(location: RouteLocation) => void>();
  let stopPopState: (() => void) | undefined;

  const ensurePopStateListener = () => {
    if (stopPopState) {
      return;
    }
    const onPopState = () => {
      const location = readLocation();
      for (const listener of listeners) {
        listener(location);
      }
    };
    window.addEventListener("popstate", onPopState);
    stopPopState = () => window.removeEventListener("popstate", onPopState);
  };

  const releasePopStateListener = () => {
    if (listeners.size === 0) {
      stopPopState?.();
      stopPopState = undefined;
    }
  };

  return {
    location: readLocation,
    // Only app-owned pushes establish a usable back target. history.length also
    // counts a WebView's initial blank document and cannot prove that boundary.
    push: (location) =>
      window.history.pushState(
        embedded ? { openclawNativeEmbedDepth: nativeEmbedHistoryDepth() + 1 } : {},
        "",
        writeLocation(location),
      ),
    replace: (location) =>
      window.history.replaceState(
        embedded ? { openclawNativeEmbedDepth: nativeEmbedHistoryDepth() } : {},
        "",
        writeLocation(location),
      ),
    listen: (listener) => {
      listeners.add(listener);
      ensurePopStateListener();
      return () => {
        listeners.delete(listener);
        releasePopStateListener();
      };
    },
  };
}
