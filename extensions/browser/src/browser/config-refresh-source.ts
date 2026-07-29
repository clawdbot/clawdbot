/**
 * Browser runtime config refresh source.
 *
 * Loads the source-backed runtime config snapshot when available so long-lived
 * browser routes can refresh from disk without changing config ownership.
 */
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";

/** Load the best available config object for browser route runtime refresh. */
export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig();
}
