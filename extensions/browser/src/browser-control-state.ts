/**
 * Shared in-process browser control runtime state.
 *
 * The HTTP server path and background control service both reuse this singleton
 * so local tools can attach to the same browser runtime without racing owners.
 */
import type { Server } from "node:http";
import { createBrowserRuntimeState, stopBrowserRuntime } from "./browser/runtime-lifecycle.js";
import { type BrowserServerState, createBrowserRouteContext } from "./browser/server-context.js";

type BrowserControlOwner = "server" | "service";

let state: BrowserServerState | null = null;
let owner: BrowserControlOwner | null = null;

export function getBrowserControlState(): BrowserServerState | null {
  return state;
}

/** Create a route context bound to the current shared browser runtime. */
export function createBrowserControlContext() {
  return createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
}

/** Start or attach the shared browser runtime for either the server or service owner. */
export async function ensureBrowserControlRuntime(params: {
  server?: Server | null;
  port: number;
  resolved: BrowserServerState["resolved"];
  owner: BrowserControlOwner;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  if (state) {
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
export async function stopBrowserControlRuntime(params: {
  requestedBy: BrowserControlOwner;
  closeServer?: boolean;
  onWarn: (message: string) => void;
}): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }
  if (params.requestedBy === "service" && current.server && owner === "server") {
    // The background service must not close a runtime currently claimed by the
    // visible HTTP server; otherwise CLI/browser calls lose their control port.
    return;
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
}
