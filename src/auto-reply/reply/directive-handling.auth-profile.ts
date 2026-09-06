// Parses auth profile directives into provider-scoped runtime overrides.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ensureAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { findPersistedAuthProfileCredential } from "../../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { isUserModelAuthProfileOwner } from "../../state/user-model-accounts.js";

/** Resolves a user-selected auth profile override for the requested provider. */
export function resolveProfileOverride(params: {
  rawProfile?: string;
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  requesterProfileId?: string;
}): { profileId?: string; error?: string; validateSelection?: () => string | undefined } {
  const raw = normalizeOptionalString(params.rawProfile);
  if (!raw) {
    return {};
  }
  const requesterProfileId = params.requesterProfileId;
  const validateSelection = isUserModelAuthProfileId(raw)
    ? () =>
        requesterProfileId &&
        isUserModelAuthProfileOwner({ profileId: requesterProfileId, authProfileId: raw })
          ? undefined
          : "Select a personal model account connected to your signed-in profile."
    : undefined;
  // Fresh selections require ownership; an opaque ID only locates an already-authorized session pin.
  const selectionError = validateSelection?.();
  if (selectionError) {
    return { error: selectionError };
  }
  // Persisted credentials are checked first because they avoid keychain prompts.
  const profile =
    findPersistedAuthProfileCredential({ agentDir: params.agentDir, profileId: raw }) ??
    ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false }).profiles[raw];
  if (!profile) {
    return { error: `Auth profile "${raw}" not found.` };
  }
  if (profile.provider !== params.provider) {
    return {
      error: `Auth profile "${raw}" is for ${profile.provider}, not ${params.provider}.`,
    };
  }
  return { profileId: raw, ...(validateSelection ? { validateSelection } : {}) };
}
