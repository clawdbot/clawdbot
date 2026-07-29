// Ollama helper module supports config compat behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { OLLAMA_CLOUD_BASE_URL, OLLAMA_CLOUD_PROVIDER_ID } from "./defaults.js";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  const record = asRecord(provider);
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
];

function migrateOllamaCloudRetiredBaseUrl(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const provider = config.models?.providers?.[OLLAMA_CLOUD_PROVIDER_ID];
  const retired = findRetiredOllamaCloudBaseUrl(provider);
  if (!retired) {
    return null;
  }

  const nextConfig = structuredClone(config);
  const nextModels = asRecord(nextConfig.models) ?? {};
  nextConfig.models = nextModels as OpenClawConfig["models"];
  const nextProviders = asRecord(nextModels.providers) ?? {};
  nextModels.providers = nextProviders;
  const nextProvider = asRecord(nextProviders[OLLAMA_CLOUD_PROVIDER_ID]) ?? {};
  nextProviders[OLLAMA_CLOUD_PROVIDER_ID] = nextProvider;

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
  return migrateOllamaCloudRetiredBaseUrl(cfg) ?? { config: cfg, changes: [] };
}
