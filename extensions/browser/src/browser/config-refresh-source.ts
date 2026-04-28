import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfig();
}
