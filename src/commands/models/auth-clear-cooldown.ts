/** Command for clearing locally stored auth-profile cooldown state. */
import {
  clearAuthProfileCooldown,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "../../agents/auth-profiles.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { RuntimeEnv } from "../../runtime.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

/**
 * Clears locally stored cooldown/disable state after an operator has confirmed
 * the provider account has recovered (for example, after a subscription reset).
 */
export async function modelsAuthClearCooldownCommand(
  opts: { profileId: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const profileId = opts.profileId?.trim();
  if (!profileId) {
    throw new Error(
      `Missing profile id. Run ${formatCliCommand("openclaw models auth list")} to see saved profile ids.`,
    );
  }

  const cfg = await loadModelsConfig({ commandName: "models auth clear-cooldown", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent);
  const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
  if (!store.usageStats?.[profileId]) {
    runtime.log(`Agent: ${agentId}`);
    runtime.log(`No stored cooldown or disable state for auth profile: ${profileId}`);
    return;
  }

  await clearAuthProfileCooldown({ store, profileId, agentDir });
  await refreshRunningGatewayAuthState();

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Cleared stored cooldown and disable state for auth profile: ${profileId}`);
}
