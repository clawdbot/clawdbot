import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { inferBasePathFromPathname, normalizeBasePath } from "../app-route-paths.ts";

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

export function createBrowserHistory(): RouterHistory {
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
    push: (location) => window.history.pushState({}, "", writeLocation(location)),
    replace: (location) => window.history.replaceState({}, "", writeLocation(location)),
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
