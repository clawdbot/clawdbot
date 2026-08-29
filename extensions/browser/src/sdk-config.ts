/**
 * Browser-local SDK config bridge.
 */
import { parseBooleanValue } from "openclaw/plugin-sdk/string-coerce-runtime";

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
  shortenHomePath,
} from "openclaw/plugin-sdk/text-utility-runtime";
/** Parses common string booleans with optional custom truthy/falsy tokens. */
export { parseBooleanValue };
