import type { Server } from "node:http";
import { createBrowserRuntimeState, stopBrowserRuntime } from "./browser/runtime-lifecycle.js";
import { type BrowserServerState, createBrowserRouteContext } from "./browser/server-context.js";

type BrowserControlOwner = "server" | "service";

let state: BrowserServerState | null = null;
let owner: BrowserControlOwner | null = null;

export function getBrowserControlState(): BrowserServerState | null {
  return state;
}

export function createBrowserControlContext() {
  return createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: true,
  });
}

export async function ensureBrowserControlRuntime(params: {
  server?: Server | null;
  port: number;
  resolved: BrowserServerState["resolved"];
  owner: BrowserControlOwner;
  onWarn: (message: string) => void;
}): Promise<BrowserServerState> {
  if (state) {
    if (params.server) {
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
