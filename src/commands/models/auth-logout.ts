/** Command for removing one saved model auth profile. */
import {
  type AuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
} from "../../agents/auth-profiles.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth-provider-config.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  configReferencesAuthProfile,
  removeAuthProfileConfig,
} from "../../plugins/provider-auth-helpers.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent, updateConfig } from "./shared.js";

// A provider entry can name an auth profile as its `apiKey`. Removing such a
// profile would leave that config key pointing at nothing and silently degrade
// the provider to an unresolvable literal key, so refuse instead.
function findProviderEntryBoundToProfile(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
}): string | undefined {
  for (const provider of Object.keys(params.cfg.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg: params.cfg,
      provider,
      store: params.store,
    });
    if (
      (reference.kind === "profile" || reference.kind === "profile-incompatible") &&
      reference.profileId === params.profileId
    ) {
      return provider;
    }
  }
  return undefined;
}

/** Removes a saved auth profile from the agent auth store and from config. */
export async function modelsAuthLogoutCommand(
  opts: { profileId: string; agent?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  const profileId = opts.profileId?.trim();
  if (!profileId) {
    throw new Error(
      `Missing profile id. Run ${formatCliCommand("openclaw models auth list")} to see saved profile ids.`,
    );
  }

  const cfg = await loadModelsConfig({ commandName: "models auth logout", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent);
  // External CLI overlays (Claude/Codex CLI) are not ours to delete, so the
  // removable set is exactly the persisted store.
  const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new Error(
      `Auth profile "${profileId}" not found for agent "${agentId}". Run ${formatCliCommand(`openclaw models auth list --agent ${agentId}`)} to see saved profile ids.`,
    );
  }

  const boundProvider = findProviderEntryBoundToProfile({ cfg, store, profileId });
  if (boundProvider) {
    throw new Error(
      `Auth profile "${profileId}" is referenced by models.providers.${boundProvider}.apiKey. Change that config value first, then rerun ${formatCliCommand(`openclaw models auth logout ${profileId}`)}.`,
    );
  }

  const description = `${profileId} (${credential.provider}/${credential.type})`;
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Refusing to remove auth profile ${description} without confirmation. Pass --yes to remove it non-interactively.`,
      );
    }
    const proceed = await createClackPrompter().confirm({
      message: `Remove auth profile ${description} from agent ${agentId}?`,
      initialValue: false,
    });
    if (!proceed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  // Config first: `auth.profiles`/`auth.order` are a separate surface from the
  // store, and a failed config write after the credential is gone would leave a
  // dangling reference that logout can no longer repair (the profile lookup
  // above would then fail). This order makes a partial failure retryable.
  if (configReferencesAuthProfile(cfg, profileId)) {
    await updateConfig((current) => removeAuthProfileConfig(current, profileId));
    logConfigUpdated(runtime);
  }

  const removed = await removeAuthProfilesAcrossOwnerStores({ agentDir, profileIds: [profileId] });
  if (!removed) {
    throw new Error(
      `Failed to remove auth profile "${profileId}"; the auth store lock may be busy. Wait a moment and retry.`,
    );
  }

  await refreshRunningGatewayAuthState();

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Removed auth profile: ${description}`);
  const remaining = listProfilesForProvider(store, credential.provider).filter(
    (id) => id !== profileId,
  );
  if (remaining.length === 0) {
    runtime.log(
      `No auth profiles remain for ${credential.provider}. Run ${formatCliCommand(`openclaw models auth login --provider ${credential.provider}`)} to sign in again.`,
    );
  }
}
