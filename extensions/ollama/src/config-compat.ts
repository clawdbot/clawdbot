// Ollama helper module supports config compat behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_DEFAULT_API_KEY,
} from "./defaults.js";

const OLLAMA_PROVIDER_ID = "ollama";
const LEGACY_OLLAMA_API_KEY_MARKER = "OLLAMA_API_KEY";
const LEGACY_OLLAMA_PROFILE_ID = "ollama:default";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown, root?: Record<string, unknown>) => boolean;
};

function isLegacyOllamaLocalConfig(provider: unknown, root?: Record<string, unknown>): boolean {
  const providerRecord = asObjectRecord(provider);
  const auth = asObjectRecord(root?.auth);
  const profiles = asObjectRecord(auth?.profiles);
  const profile = asObjectRecord(profiles?.[LEGACY_OLLAMA_PROFILE_ID]);
  return (
    providerRecord?.api === "ollama" &&
    providerRecord.apiKey === LEGACY_OLLAMA_API_KEY_MARKER &&
    profile?.provider === OLLAMA_PROVIDER_ID &&
    profile.mode === "api_key" &&
    Object.keys(profile).length === 2
  );
}

function isRetiredOllamaCloudBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    return new URL(value.trim()).hostname.toLowerCase() === "ai.ollama.com";
  } catch {
    return false;
  }
}

function findRetiredOllamaCloudBaseUrl(provider: unknown): { key: "baseUrl" | "baseURL" } | null {
  const record = asObjectRecord(provider);
  if (!record) {
    return null;
  }
  if (isRetiredOllamaCloudBaseUrl(record.baseUrl)) {
    return { key: "baseUrl" };
  }
  if (isRetiredOllamaCloudBaseUrl(record.baseURL)) {
    return { key: "baseURL" };
  }
  return null;
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["models", "providers", OLLAMA_CLOUD_PROVIDER_ID],
    message:
      'models.providers.ollama-cloud.baseUrl="https://ai.ollama.com" is retired; use "https://ollama.com". Run "openclaw doctor --fix".',
    match: (value) => findRetiredOllamaCloudBaseUrl(value) !== null,
  },
  {
    path: ["models", "providers", OLLAMA_PROVIDER_ID],
    message:
      'Legacy local Ollama authentication markers must be migrated. Run "openclaw doctor --fix".',
    match: isLegacyOllamaLocalConfig,
  },
];

function cloneProviderConfig(config: OpenClawConfig, providerId: string) {
  const nextConfig = structuredClone(config);
  const nextModels = asObjectRecord(nextConfig.models) ?? {};
  nextConfig.models = nextModels as OpenClawConfig["models"];
  const nextProviders = asObjectRecord(nextModels.providers) ?? {};
  nextModels.providers = nextProviders;
  const nextProvider = asObjectRecord(nextProviders[providerId]) ?? {};
  nextProviders[providerId] = nextProvider;
  return { nextConfig, nextProvider };
}

function migrateLegacyOllamaLocalConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const provider = config.models?.providers?.[OLLAMA_PROVIDER_ID];
  if (!isLegacyOllamaLocalConfig(provider, { ...config })) {
    return null;
  }

  const { nextConfig, nextProvider } = cloneProviderConfig(config, OLLAMA_PROVIDER_ID);
  nextProvider.apiKey = OLLAMA_DEFAULT_API_KEY;
  const nextAuth = asObjectRecord(nextConfig.auth);
  const nextProfiles = asObjectRecord(nextAuth?.profiles);
  if (nextAuth && nextProfiles) {
    delete nextProfiles[LEGACY_OLLAMA_PROFILE_ID];
    if (Object.keys(nextProfiles).length === 0) {
      delete nextAuth.profiles;
    }
    if (Object.keys(nextAuth).length === 0) {
      delete nextConfig.auth;
    }
  }
  return {
    config: nextConfig,
    changes: [
      `Migrated models.providers.${OLLAMA_PROVIDER_ID}.apiKey to ${OLLAMA_DEFAULT_API_KEY} and removed the obsolete ${LEGACY_OLLAMA_PROFILE_ID} auth profile marker.`,
    ],
  };
}

function migrateOllamaCloudRetiredBaseUrl(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const provider = config.models?.providers?.[OLLAMA_CLOUD_PROVIDER_ID];
  const retired = findRetiredOllamaCloudBaseUrl(provider);
  if (!retired) {
    return null;
  }

  const { nextConfig, nextProvider } = cloneProviderConfig(config, OLLAMA_CLOUD_PROVIDER_ID);

  const canonicalBaseUrl = nextProvider.baseUrl;
  if (
    retired.key === "baseURL" &&
    typeof canonicalBaseUrl === "string" &&
    canonicalBaseUrl.trim() &&
    !isRetiredOllamaCloudBaseUrl(canonicalBaseUrl)
  ) {
    delete nextProvider.baseURL;
    return {
      config: nextConfig,
      changes: [
        "Removed retired models.providers.ollama-cloud.baseURL while preserving models.providers.ollama-cloud.baseUrl.",
      ],
    };
  }

  nextProvider.baseUrl = OLLAMA_CLOUD_BASE_URL;
  if (retired.key === "baseURL") {
    delete nextProvider.baseURL;
  }

  return {
    config: nextConfig,
    changes: [
      `Updated models.providers.ollama-cloud.${retired.key} from the retired Ollama Cloud endpoint to ${OLLAMA_CLOUD_BASE_URL}.`,
    ],
  };
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  let config = cfg;
  const changes: string[] = [];
  for (const migrate of [migrateLegacyOllamaLocalConfig, migrateOllamaCloudRetiredBaseUrl]) {
    const result = migrate(config);
    if (result) {
      config = result.config;
      changes.push(...result.changes);
    }
  }
  return { config, changes };
}
