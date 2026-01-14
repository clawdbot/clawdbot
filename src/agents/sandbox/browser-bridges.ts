import type { BrowserBridge } from "../../browser/bridge-server.js";

export const BROWSER_BRIDGES = new Map<
  string,
  { bridge: BrowserBridge; containerName: string }
>();
