import type { CliBackendConfig } from "../config/types.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "../agents/cli-watchdog-defaults.js";

export { CLI_FRESH_WATCHDOG_DEFAULTS, CLI_RESUME_WATCHDOG_DEFAULTS };
export type { CliBackendConfig };

export type CliBackendPlugin = {
  id: string;
  config: CliBackendConfig;
  bundleMcp?: boolean;
  bundleMcpMode?: string;
  normalizeConfig?: (config: CliBackendConfig) => CliBackendConfig;
  liveTest?: {
    defaultModelRef?: string;
    defaultImageProbe?: boolean;
    defaultMcpProbe?: boolean;
    docker?: {
      npmPackage?: string;
      binaryName?: string;
    };
  };
};
