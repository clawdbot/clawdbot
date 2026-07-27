// Doctor repair for provider apiKey edits in openclaw.json that never reach
// the SQLite auth profile the runtime actually resolves for that provider,
// so the edit has no effect until the profile is separately updated
// (openclaw/openclaw#113599).
import {
  listAgentEntries,
  resolveAgentDir,
  resolveDefaultAgentDir,
} from "../../../agents/agent-scope-config.js";
import {
  resolveAuthProfileOrder,
  resolveAuthStorePathForDisplay,
} from "../../../agents/auth-profiles.js";
import { loadPersistedAuthProfileStore } from "../../../agents/auth-profiles/persisted.js";
import { updateAuthProfileStoreWithLock } from "../../../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { isNonSecretApiKeyMarker } from "../../../agents/model-auth-markers.js";
import {
  resolveProviderConfig,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../../../agents/model-auth-provider-config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { coerceSecretRef } from "../../../config/types.secrets.js";
import { isRecord, shortenHomePath } from "../../../utils.js";
import { normalizeOptionalSecretInput } from "../../../utils/normalize-secret-input.js";

type ConfigAuthProfileApiKeyDrift = {
  agentDir: string;
  provider: string;
  profileId: string;
  configApiKey: string;
};

function resolveConfiguredProviderIds(cfg: OpenClawConfig): string[] {
  const models = isRecord(cfg.models) ? cfg.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  return Object.keys(providers);
}

function collectCandidateAgentDirs(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const dirs = new Set<string>([resolveDefaultAgentDir(cfg, env)]);
  for (const entry of listAgentEntries(cfg)) {
    const id = entry.id?.trim();
    if (id) {
      dirs.add(resolveAgentDir(cfg, id, env));
    }
  }
  return [...dirs];
}

/** Literal apiKey configured for a provider entry, or null when unset/SecretRef/marker. */
function resolveConfiguredLiteralApiKey(cfg: OpenClawConfig, provider: string): string | null {
  const providerConfig = resolveProviderConfig(cfg, provider);
  if (!providerConfig || coerceSecretRef(providerConfig.apiKey)) {
    return null;
  }
  const literal = normalizeOptionalSecretInput(providerConfig.apiKey);
  if (!literal || isNonSecretApiKeyMarker(literal)) {
    return null;
  }
  return literal;
}

/** Finds the api_key auth profile the runtime would resolve for this provider today. */
function resolveActiveApiKeyProfile(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
}): { profileId: string; key: string } | null {
  const candidates = resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
  });
  for (const profileId of candidates) {
    const credential = params.store.profiles[profileId];
    if (credential?.type === "api_key" && credential.key) {
      return { profileId, key: credential.key };
    }
  }
  return null;
}

/** Detect providers whose configured apiKey no longer matches the auth profile the runtime uses. */
export function scanConfigAuthProfileApiKeyDrifts(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ConfigAuthProfileApiKeyDrift[] {
  const env = params.env ?? process.env;
  const providers = resolveConfiguredProviderIds(params.cfg).filter(
    (provider) => !shouldPreferExplicitConfigApiKeyAuth(params.cfg, provider),
  );
  if (providers.length === 0) {
    return [];
  }
  const hits: ConfigAuthProfileApiKeyDrift[] = [];
  for (const agentDir of collectCandidateAgentDirs(params.cfg, env)) {
    const store = loadPersistedAuthProfileStore(agentDir);
    if (!store) {
      continue;
    }
    for (const provider of providers) {
      const configApiKey = resolveConfiguredLiteralApiKey(params.cfg, provider);
      if (!configApiKey) {
        continue;
      }
      const active = resolveActiveApiKeyProfile({ cfg: params.cfg, store, provider });
      if (active && active.key !== configApiKey) {
        hits.push({ agentDir, provider, profileId: active.profileId, configApiKey });
      }
    }
  }
  return hits;
}

/** Format warnings for provider apiKey edits shadowed by a stored auth profile. */
export function collectConfigAuthProfileApiKeyDriftWarnings(params: {
  hits: ConfigAuthProfileApiKeyDrift[];
  doctorFixCommand: string;
}): string[] {
  return params.hits.map(
    (hit) =>
      `- Provider "${hit.provider}" has a new apiKey in openclaw.json, but auth profile "${hit.profileId}" in ${shortenHomePath(resolveAuthStorePathForDisplay(hit.agentDir))} still holds the previous key and is what the runtime sends. Run "${params.doctorFixCommand}" to update the stored profile to match, or set auth: "api-key" on this provider entry to always prefer config.`,
  );
}

/** Update stored auth profiles so each provider's runtime credential matches its configured apiKey. */
export async function repairConfigAuthProfileApiKeyDrifts(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const hits = scanConfigAuthProfileApiKeyDrifts(params);
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const hit of hits) {
    let updated = false;
    const result = await updateAuthProfileStoreWithLock({
      agentDir: hit.agentDir,
      updater: (store) => {
        const credential = store.profiles[hit.profileId];
        if (credential?.type !== "api_key" || credential.key === hit.configApiKey) {
          return false;
        }
        store.profiles[hit.profileId] = { ...credential, key: hit.configApiKey };
        updated = true;
        return true;
      },
    });
    if (result && updated) {
      changes.push(
        `Updated auth profile "${hit.profileId}" for provider "${hit.provider}" in ${shortenHomePath(resolveAuthStorePathForDisplay(hit.agentDir))} to match the apiKey configured in openclaw.json.`,
      );
    } else if (!result) {
      warnings.push(
        `Failed to sync auth profile "${hit.profileId}" for provider "${hit.provider}" from openclaw.json; the auth store lock may be busy. Retry "openclaw doctor --fix".`,
      );
    }
  }
  return { changes, warnings };
}
