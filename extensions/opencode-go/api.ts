import {
  applyAgentDefaultModelPrimary,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { OPENCODE_GO_DEFAULT_MODEL_REF } from "./onboard.js";

export {
  applyOpencodeGoConfig,
  applyOpencodeGoProviderConfig,
  OPENCODE_GO_DEFAULT_MODEL_REF,
} from "./onboard.js";

export function applyOpencodeGoModelDefault(
  cfg: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig,
): {
  next: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig;
  changed: boolean;
} {
  const current = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  if (current === OPENCODE_GO_DEFAULT_MODEL_REF) {
    return { next: cfg, changed: false };
  }
  return {
    next: applyAgentDefaultModelPrimary(cfg, OPENCODE_GO_DEFAULT_MODEL_REF),
    changed: true,
  };
}
