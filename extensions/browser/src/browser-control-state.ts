/**
 * Shared in-process browser control runtime state.
 *
 * The HTTP server path and background control service both reuse this singleton
 * so local tools can attach to the same browser runtime without racing owners.
 */
import type { Server } from "node:http";
import { BrowserProfileUnavailableError } from "./browser/errors.js";
import { createBrowserRuntimeState, stopBrowserRuntime } from "./browser/runtime-lifecycle.js";
import { type BrowserServerState, createBrowserRouteContext } from "./browser/server-context.js";
import { isBrowserRuntimeRunning } from "./browser/server-context.lifecycle.js";

type BrowserControlOwner = "server" | "service";

let state: BrowserServerState | null = null;
let owner: BrowserControlOwner | null = null;
let lifecycleTail = Promise.resolve();
let completedEffectiveStops = 0;

/** Serialize complete Browser runtime start/stop workflows. */
function enqueueBrowserControlLifecycle<T>(run: () => Promise<T>): Promise<T> {
  const result = lifecycleTail.then(run, run);
  lifecycleTail = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Queue startup, but never turn a request made during shutdown into a post-stop restart. */
export function withBrowserControlStart<T>(run: () => Promise<T>): Promise<T> {
  const effectiveStopsAtRequest = completedEffectiveStops;
  return enqueueBrowserControlLifecycle(() => {
    if (
      completedEffectiveStops !== effectiveStopsAtRequest ||
      (state ? !isBrowserRuntimeRunning(state) : false)
    ) {
      throw new BrowserProfileUnavailableError("Browser runtime is stopping.");
    }
    return run();
  });
}

export function getBrowserControlState(): BrowserServerState | null {
  return state && isBrowserRuntimeRunning(state) ? state : null;
}

/** Create a route context bound to the current shared browser runtime. */
export function createBrowserControlContext() {
  return createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
}

/**
 * Start or attach the shared runtime. Call only from a queued `withBrowserControlStart` entry.
 */
export async function ensureBrowserControlRuntime(params: {
  server?: Server | null;
  port: number;
  resolved: BrowserServerState["resolved"];
  owner: BrowserControlOwner;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  if (state && isBrowserRuntimeRunning(state)) {
    if (params.server) {
      // A foreground server takes ownership of the already-started service
      // runtime so shutdown and port reporting follow the visible server.
      state.server = params.server;
      state.port = params.port;
      state.resolved = { ...params.resolved, controlPort: params.port };
      owner = "server";
    }
    return state;
  }
  if (state) {
    throw new BrowserProfileUnavailableError("Browser runtime cleanup must finish before restart.");
  }

  state = await createBrowserRuntimeState({
    server: params.server ?? null,
    port: params.port,
    resolved: params.resolved,
    onWarn: params.onWarn,
  });
  owner = params.owner;
  return state;
}

/** Stop the shared browser runtime when the requesting owner is allowed to do so. */
export function stopBrowserControlRuntime(params: {
  requestedBy: BrowserControlOwner;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState | null> {
  return enqueueBrowserControlLifecycle(async () => {
    const current = state;
    if (!current) {
      return null;
    }
    if (params.requestedBy === "service" && current.server && owner === "server") {
      // The background service must not close a runtime currently claimed by the
      // visible HTTP server; otherwise CLI/browser calls lose their control port.
      return null;
    }
    await stopBrowserRuntime({
      current,
      getState: () => state,
      clearState: () => {
        state = null;
        owner = null;
      },
      closeServer: params.closeServer,
      onWarn: params.onWarn,
    });
    completedEffectiveStops += 1;
    return current;
  });
}
