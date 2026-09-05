/** Keep bridge lifecycle and auth state in the same owner as the full runtime. */
export {
  type BrowserBridge,
  startBrowserBridgeServer,
  stopBrowserBridgeServer,
} from "./src/browser/bridge-server.js";
