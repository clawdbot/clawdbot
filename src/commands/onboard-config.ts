/** Shared config mutations used by interactive and non-interactive onboarding. */
import { setConfigValueAtPath } from "../config/config-paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ToolProfileId } from "../config/types.tools.js";

/** Default tool profile selected during local onboarding. */
const ONBOARDING_DEFAULT_TOOLS_PROFILE: ToolProfileId = "coding";

/** Applies local gateway/workspace defaults without overwriting explicit user defaults. */
// Deliberately writes no session.dmScope: the schema default "main" (one rolling
// personal-agent session across channels) is the product default. Multi-user DM
// isolation is opt-in; `openclaw security audit` nudges it when traffic warrants.
export function applyLocalSetupWorkspaceConfig(
  baseConfig: OpenClawConfig,
  workspaceDir: string,
): OpenClawConfig {
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
    tools: {
      ...baseConfig.tools,
      profile: baseConfig.tools?.profile ?? ONBOARDING_DEFAULT_TOOLS_PROFILE,
    },
  };
}

/** Marks default agents to skip bootstrap file creation. */
export function applySkipBootstrapConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(cfg);
  setConfigValueAtPath(
    next as Record<string, unknown>,
    ["agents", "defaults", "skipBootstrap"],
    true,
  );
  return next;
}
