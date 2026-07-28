import type { OpenClawConfig } from "../config/types.openclaw.js";

export const POST_CORE_UPDATE_ENV = "OPENCLAW_UPDATE_POST_CORE";
export const POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV =
  "OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH";

export type PreUpdateConfigRestoreInput = {
  sourceConfig: OpenClawConfig;
  authoredConfig: OpenClawConfig;
};
