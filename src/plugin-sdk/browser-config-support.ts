// Compat surface: openclaw/plugin-sdk/browser-config-support
// Re-exports stable browser config and host helpers for the browser extension.

export {
  CONFIG_DIR,
  escapeRegExp,
  resolveUserPath,
  shortenHomePath,
} from "../utils.js";
export {
  DEFAULT_BROWSER_CONTROL_PORT,
  deriveDefaultBrowserCdpPortRange,
  deriveDefaultBrowserControlPort,
} from "../config/port-defaults.js";
export { resolveGatewayPort } from "../config/paths.js";
export { isLoopbackHost } from "../gateway/net.js";
