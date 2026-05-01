import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfigSourceSnapshot() ?? getRuntimeConfig();
}
