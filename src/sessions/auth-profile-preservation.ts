import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  findPersistedAuthProfileCredential,
  getRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/store.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

function resolvePinnedAuthProfileProvider(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  profileId: string;
}): string | undefined {
  const storedProvider =
    getRuntimeAuthProfileStoreSnapshot(params.agentDir)?.profiles[params.profileId]?.provider ??
    findPersistedAuthProfileCredential({
      agentDir: params.agentDir,
      profileId: params.profileId,
    })?.provider;
  return storedProvider ?? params.cfg.auth?.profiles?.[params.profileId]?.provider;
}

/** Checks whether a pinned session auth profile can authenticate the selected provider. */
export function shouldPreserveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  entry: SessionEntry;
  currentProvider: string;
  provider: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): boolean {
  const profileOverride = normalizeOptionalString(params.entry.authProfileOverride);
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (!profileOverride || !provider) {
    return false;
  }
  const resolvesToTargetProvider = (rawProvider: string | undefined): boolean => {
    const candidate = normalizeOptionalLowercaseString(rawProvider);
    const lookupParams = {
      config: params.cfg,
      ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    };
    return Boolean(
      candidate &&
      resolveProviderIdForAuth(candidate, lookupParams) ===
        resolveProviderIdForAuth(provider, lookupParams),
    );
  };
  const recordedProvider = resolvePinnedAuthProfileProvider({
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileId: profileOverride,
  });
  if (recordedProvider) {
    return resolvesToTargetProvider(recordedProvider);
  }
  const delimiterIndex = profileOverride.indexOf(":");
  // Missing personal IDs carry no provider; admission must report the unavailable account, not replace it.
  if (delimiterIndex < 0 || isUserModelAuthProfileId(profileOverride)) {
    return resolvesToTargetProvider(params.currentProvider);
  }
  return resolvesToTargetProvider(profileOverride.slice(0, delimiterIndex));
}

/** Applies a user model selection without dropping a compatible pinned auth profile. */
export function applyModelOverrideWithAuthProfileCompatibility(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  entry: SessionEntry;
  currentProvider: string;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  selectionSource?: "auto" | "user";
  markLiveSwitchPending?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): { updated: boolean } {
  return applyModelOverrideToSessionEntry({
    entry: params.entry,
    selection: params.selection,
    ...(params.profileOverride ? { profileOverride: params.profileOverride } : {}),
    ...(params.profileOverrideSource
      ? { profileOverrideSource: params.profileOverrideSource }
      : {}),
    ...(params.selectionSource ? { selectionSource: params.selectionSource } : {}),
    ...(params.markLiveSwitchPending !== undefined
      ? { markLiveSwitchPending: params.markLiveSwitchPending }
      : {}),
    preserveAuthProfileOverride:
      !params.profileOverride &&
      shouldPreserveSessionAuthProfileOverride({
        cfg: params.cfg,
        agentDir: params.agentDir,
        entry: params.entry,
        currentProvider: params.currentProvider,
        provider: params.selection.provider,
        ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
      }),
  });
}
