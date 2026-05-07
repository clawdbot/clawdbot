import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
} from "./cli-credentials.js";
import { resolveEnvApiKey, resolveUsableCustomProviderApiKey } from "./model-auth.js";
import { normalizeProviderId } from "./model-selection.js";

export function resolveModelAuthLabel(params: {
  provider?: string;
  cfg?: OpenClawConfig;
  sessionEntry?: Partial<Pick<SessionEntry, "authProfileOverride">>;
  agentDir?: string;
  workspaceDir?: string;
  includeExternalProfiles?: boolean;
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
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: providerKey,
    preferredProfile: profileOverride,
  });
  const candidates = [profileOverride, ...order].filter(Boolean) as string[];

  for (const profileId of candidates) {
    const profile = store.profiles[profileId];
    if (!profile || normalizeProviderId(profile.provider) !== providerKey) {
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
