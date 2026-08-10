// LongCat doctor contract: migrates the retired unversioned default baseUrl
// to the documented /openai/v1 endpoint. Onboarding persists
// `models.providers.longcat.baseUrl` and the runtime reads the stored value,
// so a manifest-only update never reaches existing installations. Only the
// exact former default is rewritten; custom endpoints are preserved.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_PATH = "models.providers.longcat";
const LEGACY_DEFAULT_BASE_URL = "https://api.longcat.chat/openai";
const CANONICAL_BASE_URL: string = manifest.modelCatalog.providers.longcat.baseUrl;
const FIX_HINT = `Run "openclaw doctor --fix" (the former default ${LEGACY_DEFAULT_BASE_URL} migrates to ${CANONICAL_BASE_URL} automatically; custom endpoints are left unchanged).`;

// Matches only the retired default, tolerating trailing-slash variants.
// Any other value is operator-configured and must never be rewritten.
function isLegacyDefaultBaseUrl(value: unknown): boolean {
  return typeof value === "string" && value.trim().replace(/\/+$/u, "") === LEGACY_DEFAULT_BASE_URL;
}

export const legacyConfigRules = [
  {
    path: ["models", "providers", "longcat", "baseUrl"],
    message: `${PROVIDER_PATH}.baseUrl targets the retired unversioned ${LEGACY_DEFAULT_BASE_URL} default; the documented endpoint is ${CANONICAL_BASE_URL}. ${FIX_HINT}`,
    match: isLegacyDefaultBaseUrl,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const models = asObjectRecord(cfg.models);
  const providers = asObjectRecord(models?.providers);
  const provider = asObjectRecord(providers?.longcat);
  if (!provider || !isLegacyDefaultBaseUrl(provider.baseUrl)) {
    return { config: cfg, changes: [] };
  }

  return {
    config: {
      ...cfg,
      models: {
        ...models,
        providers: {
          ...providers,
          longcat: { ...provider, baseUrl: CANONICAL_BASE_URL },
        },
      } as unknown as OpenClawConfig["models"],
    },
    changes: [`${PROVIDER_PATH}.baseUrl: ${LEGACY_DEFAULT_BASE_URL} -> ${CANONICAL_BASE_URL}`],
  };
}
