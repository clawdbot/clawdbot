// Qa Lab plugin module owns host live-provider config projection.
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  isRecord,
  normalizeOptionalString,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { QA_LIVE_PROVIDER_CONFIG_PATH_ENV, resolveQaLiveProviderConfigPath } from "./env.js";

function isQaModelProviderConfig(value: unknown): value is ModelProviderConfig {
  return isRecord(value) && typeof value.baseUrl === "string" && Array.isArray(value.models);
}

function normalizeQaLiveProviderConfig(value: unknown): ModelProviderConfig | null {
  if (!isQaModelProviderConfig(value) && (!isRecord(value) || !Object.hasOwn(value, "apiKey"))) {
    return null;
  }
  const { baseUrl: rawBaseUrl, ...providerConfig } = value;
  const baseUrl = normalizeOptionalString(rawBaseUrl);
  return {
    ...providerConfig,
    ...(baseUrl ? { baseUrl } : {}),
    models: Array.isArray(value.models) ? value.models : [],
  } as ModelProviderConfig;
}

export async function readQaLiveProviderConfigOverrides(params: {
  providerIds: readonly string[];
  env?: NodeJS.ProcessEnv;
}) {
  const providerIds = uniqueStrings(normalizeStringEntries(params.providerIds));
  if (providerIds.length === 0) {
    return {};
  }
  const configPath = resolveQaLiveProviderConfigPath(params.env);
  if (!existsSync(configPath.path)) {
    return {};
  }
  try {
    const raw = await fs.readFile(configPath.path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const providers = isRecord(parsed)
      ? isRecord(parsed.models)
        ? isRecord(parsed.models.providers)
          ? parsed.models.providers
          : {}
        : {}
      : {};
    const selected: Record<string, ModelProviderConfig> = {};
    for (const providerId of providerIds) {
      const providerConfig = normalizeQaLiveProviderConfig(providers[providerId]);
      if (providerConfig) {
        selected[providerId] = providerConfig;
      }
    }
    return selected;
  } catch (error) {
    if (configPath.explicit) {
      throw new Error(
        `failed to read ${QA_LIVE_PROVIDER_CONFIG_PATH_ENV} provider config: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    }
    return {};
  }
}
