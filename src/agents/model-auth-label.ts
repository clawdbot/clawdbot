/**
 * Formats user-facing auth labels for resolved provider/model credentials.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "./auth-profiles/order.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
} from "./cli-credentials.js";
import {
  resolveEnvApiKey,
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
} from "./model-auth.js";
import { normalizeProviderId } from "./model-selection.js";

// Builds concise auth labels for UI/status surfaces without exposing credential
// values. Resolution follows profile override, provider profiles, env, CLI, then
// custom provider config.
/** Resolve the display label that describes how a provider is authenticated. */
export function resolveModelAuthLabel(params: {
  provider?: string;
  cfg?: OpenClawConfig;
  sessionEntry?: Partial<Pick<SessionEntry, "authProfileOverride">>;
  agentDir?: string;
  workspaceDir?: string;
  includeExternalProfiles?: boolean;
  acceptedProviderIds?: readonly string[];
}): string | undefined {
  const resolvedProvider = params.provider?.trim();
  if (!resolvedProvider) {
    return undefined;
  }

  const providerKey = normalizeProviderId(resolvedProvider);
  const store =
    params.includeExternalProfiles === false
      ? loadAuthProfileStoreWithoutExternalProfiles(params.agentDir)
      : ensureAuthProfileStore(params.agentDir, {
          externalCli: externalCliDiscoveryForProviderAuth({
            cfg: params.cfg,
            provider: providerKey,
            preferredProfile: params.sessionEntry?.authProfileOverride,
          }),
        });
  const profileOverride = params.sessionEntry?.authProfileOverride?.trim();
  const acceptedProviderKeys = uniqueStrings(
    [...(params.acceptedProviderIds ?? []).map(normalizeProviderId), providerKey].filter(Boolean),
  );
  const order = uniqueStrings(
    acceptedProviderKeys.flatMap((acceptedProvider) =>
      resolveAuthProfileOrder({
        cfg: params.cfg,
        store,
        provider: acceptedProvider,
        preferredProfile: profileOverride,
      }),
    ),
  );
  const candidates = [profileOverride, ...order].filter(Boolean) as string[];

  for (const profileId of candidates) {
    const profile = store.profiles[profileId];
    if (
      !profile ||
      !acceptedProviderKeys.some((acceptedProvider) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: params.cfg,
          provider: acceptedProvider,
          credential: profile,
        }),
      )
    ) {
      continue;
    }
    const label = resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store,
      profileId,
    });
    if (profile.type === "oauth") {
      return `oauth${label ? ` (${label})` : ""}`;
    }
    if (profile.type === "token") {
      return `token${label ? ` (${label})` : ""}`;
    }
    return `api-key${label ? ` (${label})` : ""}`;
  }

  const providerEntryProfileRef = resolveProviderEntryApiKeyProfileReference({
    cfg: params.cfg,
    provider: providerKey,
    store,
  });
  if (providerEntryProfileRef.kind === "profile") {
    const label = resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store,
      profileId: providerEntryProfileRef.profileId,
    });
    if (providerEntryProfileRef.mode === "token") {
      return `token${label ? ` (${label})` : ""}`;
    }
    return `api-key${label ? ` (${label})` : ""}`;
  }
  if (providerEntryProfileRef.kind === "profile-incompatible") {
    // Preserve the fact that config pointed at a profile while avoiding a
    // misleading auth mode for an incompatible provider/profile pairing.
    return "unknown";
  }

  const envKey = resolveEnvApiKey(providerKey, process.env, {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  if (envKey?.apiKey) {
    if (envKey.source.includes("OAUTH_TOKEN")) {
      return `oauth (${envKey.source})`;
    }
    return `api-key (${envKey.source})`;
  }

  if (
    providerKey === "codex" &&
    readCodexCliCredentialsCached({ ttlMs: 5_000, allowKeychainPrompt: false })
  ) {
    return "oauth (codex-cli)";
  }
  if (
    providerKey === "claude-cli" &&
    readClaudeCliCredentialsCached({ ttlMs: 5_000, allowKeychainPrompt: false })
  ) {
    return "oauth (claude-cli)";
  }

  const customKey = resolveUsableCustomProviderApiKey({
    cfg: params.cfg,
    provider: providerKey,
  });
  if (customKey) {
    return `api-key (models.json)`;
  }

  return "unknown";
}
