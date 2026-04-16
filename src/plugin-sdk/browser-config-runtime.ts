// Compat surface: openclaw/plugin-sdk/browser-config-runtime
// Re-exports stable config/runtime symbols used by the browser extension.

export { loadConfig } from "../config/io.js";
export { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";
export { parseBooleanValue } from "../utils/boolean.js";
export { shortenHomePath } from "../utils.js";
export type { OpenClawConfig } from "../config/config.js";
