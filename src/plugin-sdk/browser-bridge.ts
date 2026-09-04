/**
 * Public SDK facade for starting and stopping the bundled browser bridge server.
 */
import type { Server } from "node:http";
import type { ResolvedBrowserConfig } from "./browser-types.js";
import { loadActivatedBundledPluginPublicSurfaceModule } from "./facade-runtime.js";

/** Running browser bridge server state returned to plugin callers. */
export type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: {
    resolved: ResolvedBrowserConfig;
  };
};

type BrowserBridgeFacadeModule = {
  startBrowserBridgeServer(params: {
    resolved: ResolvedBrowserConfig;
    host?: string;
    port?: number;
    authToken?: string;
    authPassword?: string;
    onEnsureAttachTarget?: (profile: unknown) => Promise<void>;
    resolveSandboxNoVncToken?: (token: string) => { noVncPort: number; password?: string } | null;
  }): Promise<BrowserBridge>;
  stopBrowserBridgeServer(server: Server): Promise<void>;
};

function loadFacadeModule(): Promise<BrowserBridgeFacadeModule> {
  return loadActivatedBundledPluginPublicSurfaceModule<BrowserBridgeFacadeModule>({
    dirName: "browser",
    artifactBasename: "runtime-api.js",
  });
}

/** Starts the browser bridge runtime from the activated browser plugin facade. */
export async function startBrowserBridgeServer(
  params: Parameters<BrowserBridgeFacadeModule["startBrowserBridgeServer"]>[0],
): Promise<BrowserBridge> {
  return await (await loadFacadeModule()).startBrowserBridgeServer(params);
}

/** Stops a browser bridge server previously returned by startBrowserBridgeServer. */
export async function stopBrowserBridgeServer(server: Server): Promise<void> {
  await (await loadFacadeModule()).stopBrowserBridgeServer(server);
}
