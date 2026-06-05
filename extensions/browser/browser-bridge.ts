/**
 * Browser bridge API barrel. It exposes the host/sandbox bridge server handle
 * and lifecycle helpers without importing the full browser plugin entry.
 */
export type { BrowserBridge } from "./src/browser/bridge-server.js";
export { startBrowserBridgeServer, stopBrowserBridgeServer } from "./src/browser/bridge-server.js";
