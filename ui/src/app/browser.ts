import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import { inferBasePathFromPathname, normalizeBasePath } from "../app-route-paths.ts";

type WindowWithControlUiBasePath = Window &
  typeof globalThis & {
    [key: string]: unknown;
  };

function readControlUiResourceBasePath(): string | null {
  if (typeof window !== "undefined") {
    const windowValue = (window as WindowWithControlUiBasePath)[
      "__OPENCLAW_CONTROL_UI_BASE_PATH__"
    ];
    if (typeof windowValue === "string") {
      return normalizeBasePath(windowValue);
    }
  }
  if (typeof document !== "undefined") {
    const documentValue = document.documentElement.getAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
    if (documentValue !== null) {
      return normalizeBasePath(documentValue);
    }
  }
  return null;
}

/** Route mount used by the application router and navigation URLs. */
export function resolveControlUiBasePath(pathname: string): string {
  return resolveControlUiPaths(pathname).basePath;
}

/** Gateway HTTP mount used by config, media, icons, avatars, and static assets. */
export function resolveControlUiResourceBasePath(pathname: string): string {
  return resolveControlUiPaths(pathname).resourceBasePath;
}

export function resolveControlUiPaths(pathname: string) {
  const resourceBasePath = readControlUiResourceBasePath();
  const inferredBasePath = resourceBasePath
    ? resourceBasePath
    : inferBasePathFromPathname(pathname);
  return {
    basePath: inferredBasePath,
    resourceBasePath: resourceBasePath ?? inferredBasePath,
  };
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
