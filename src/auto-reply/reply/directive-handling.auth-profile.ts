// Parses auth profile directives into provider-scoped runtime overrides.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
} from "../../agents/auth-profiles/store.js";
import type { ModelManifestPluginContext } from "../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Resolves a user-selected auth profile override for the requested provider. */
export function resolveProfileOverride(params: {
  rawProfile?: string;
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  manifestPluginContext?: ModelManifestPluginContext;
}): { profileId?: string; error?: string } {
  const raw = normalizeOptionalString(params.rawProfile);
  if (!raw) {
    return {};
  }
  // Persisted credentials are checked first because they avoid keychain prompts.
  const persistedProfile = findPersistedAuthProfileCredential({
    agentDir: params.agentDir,
    profileId: raw,
  });
  if (persistedProfile) {
    if (persistedProfile.provider !== params.provider) {
      return {
        error: `Auth profile "${raw}" is for ${persistedProfile.provider}, not ${params.provider}.`,
      };
    }
    return { profileId: raw };
  }

  const context = params.manifestPluginContext?.getContext();
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    config: params.cfg,
    workspaceDir: context?.pluginMetadataSnapshot ? context.workspaceDir : params.workspaceDir,
    pluginMetadataSnapshot: context?.pluginMetadataSnapshot,
  });
  const profile = store.profiles[raw];
  if (!profile) {
    return { error: `Auth profile "${raw}" not found.` };
  }
  if (profile.provider !== params.provider) {
    return {
      error: `Auth profile "${raw}" is for ${profile.provider}, not ${params.provider}.`,
    };
  }
  return { profileId: raw };
}
