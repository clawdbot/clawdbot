export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  DEFAULT_UPLOAD_DIR,
  resolveBrowserConfig,
  resolveProfile,
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
  type ResolvedBrowserTabCleanupConfig,
} from "./browser-profiles.js";
export { parseBrowserHttpUrl, redactCdpUrl } from "./browser-cdp.js";
export { ensureBrowserControlAuth, resolveBrowserControlAuth } from "./browser-control-auth.js";
export type { BrowserControlAuth } from "./browser-control-auth.js";
