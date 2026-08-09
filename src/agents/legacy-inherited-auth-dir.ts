import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { tryGetLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentDir, tryResolveSoleAgentId } from "./agent-scope-config.js";

export function resolveLegacyInheritedAuthAgentId(config: OpenClawConfig): string {
  return (
    normalizeOptionalString(config.agents?.defaults?.authInheritance?.agentId) ??
    tryGetLegacyDefaultAgentId(config) ??
    tryResolveSoleAgentId(config) ??
    "main"
  );
}

export function resolveLegacyInheritedAuthDir(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveAgentDir(config, resolveLegacyInheritedAuthAgentId(config), env);
}

export function pinLegacyInheritedAuthOwnerForRosterTransition(
  sourceConfig: OpenClawConfig,
  targetConfig: OpenClawConfig,
): OpenClawConfig {
  const sourceOwner = resolveLegacyInheritedAuthAgentId(sourceConfig);
  if (sourceOwner === resolveLegacyInheritedAuthAgentId(targetConfig)) {
    return targetConfig;
  }
  return {
    ...targetConfig,
    agents: {
      ...targetConfig.agents,
      defaults: {
        ...targetConfig.agents?.defaults,
        authInheritance: {
          ...targetConfig.agents?.defaults?.authInheritance,
          agentId: sourceOwner,
        },
      },
    },
  };
}
