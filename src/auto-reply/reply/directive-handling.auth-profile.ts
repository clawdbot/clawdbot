import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
} from "../../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export function resolveProfileOverride(params: {
  rawProfile?: string;
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
}): { profileId?: string; error?: string } {
  const raw = normalizeOptionalString(params.rawProfile);
  if (!raw) {
    return {};
  }
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

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
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
