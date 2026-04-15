import { createConfigIO, getRuntimeConfigSnapshot, type OpenClawConfig } from "../config/config.js";

export function loadBrowserConfigForRuntimeRefresh(): OpenClawConfig {
  return getRuntimeConfigSnapshot() ?? createConfigIO().loadConfig();
}
