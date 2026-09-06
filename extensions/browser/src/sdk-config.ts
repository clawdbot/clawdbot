/**
 * Browser-local SDK config bridge.
 */
export {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
export { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
export type { BrowserProfileConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "openclaw/plugin-sdk/plugin-config-runtime";
export {
  CONFIG_DIR,
  escapeRegExp,
  resolveUserPath,
} from "openclaw/plugin-sdk/text-utility-runtime";
