// DeepInfra doctor contract: migrates legacy video endpoint config to the
// canonical `models.providers.deepinfra.baseUrl`. Runtime reads only the
// canonical key; `openclaw doctor --fix` repairs shipped `nativeBaseUrl` and
// `/v1/inference` values here so no request-time compat remap is needed.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_PATH = "models.providers.deepinfra";
const NATIVE_INFERENCE_PATH = "/v1/inference";
const OPENAI_COMPAT_PATH = "/v1/openai";
const CANONICAL_BASE_URL: string = manifest.modelCatalog.providers.deepinfra.baseUrl;
const FIX_HINT = `Run "openclaw doctor --fix" (api.deepinfra.com endpoints migrate automatically; custom hosts must set ${PROVIDER_PATH}.baseUrl to an OpenAI-compatible videos endpoint manually).`;

export const legacyConfigRules = [
  {
    path: ["models", "providers", "deepinfra", "nativeBaseUrl"],
    message: `${PROVIDER_PATH}.nativeBaseUrl is legacy; video generation uses the OpenAI-compatible ${PROVIDER_PATH}.baseUrl. ${FIX_HINT}`,
  },
  {
    path: ["models", "providers", "deepinfra", "baseUrl"],
    message: `${PROVIDER_PATH}.baseUrl targets the retired native ${NATIVE_INFERENCE_PATH} surface; use an ${OPENAI_COMPAT_PATH} base. ${FIX_HINT}`,
    match: (value: unknown) => typeof value === "string" && value.includes(NATIVE_INFERENCE_PATH),
  },
];

// Only DeepInfra's own host provably serves both the native and the OpenAI
// video surfaces; rewriting a custom host's URL cannot make it speak the
// OpenAI videos protocol, so custom endpoints are never auto-converted.
function isDeepInfraApiHost(value: string): boolean {
  try {
    return new URL(value).host === "api.deepinfra.com";
  } catch {
    return false;
  }
}

function normalizeBaseUrlValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\/+$/u, "");
  return trimmed ? trimmed : undefined;
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const models = asObjectRecord(cfg.models);
  const providers = asObjectRecord(models?.providers);
  const provider = asObjectRecord(providers?.deepinfra);
  if (!provider) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  const next: Record<string, unknown> = { ...provider };

  // Change messages never echo configured URL values: a legacy URL may carry
  // userinfo or query tokens, and doctor output lands in terminals/CI logs.
  if (Object.hasOwn(next, "nativeBaseUrl")) {
    const legacyNative = normalizeBaseUrlValue(next.nativeBaseUrl);
    delete next.nativeBaseUrl;
    if (normalizeBaseUrlValue(next.baseUrl)) {
      changes.push(`${PROVIDER_PATH}.nativeBaseUrl: removed (baseUrl is already configured)`);
    } else if (legacyNative && !isDeepInfraApiHost(legacyNative)) {
      // The native video route is retired, so a custom native endpoint cannot
      // be preserved; provider entries require baseUrl, so fall back to the
      // canonical endpoint and tell the operator what manual step remains.
      next.baseUrl = CANONICAL_BASE_URL;
      changes.push(
        `${PROVIDER_PATH}.nativeBaseUrl: removed retired custom native endpoint; using ${CANONICAL_BASE_URL} - set ${PROVIDER_PATH}.baseUrl manually if your host serves an OpenAI-compatible videos API`,
      );
    } else {
      const migrated = legacyNative?.includes(NATIVE_INFERENCE_PATH)
        ? legacyNative.replace(NATIVE_INFERENCE_PATH, OPENAI_COMPAT_PATH)
        : CANONICAL_BASE_URL;
      next.baseUrl = migrated;
      changes.push(
        `${PROVIDER_PATH}.nativeBaseUrl -> ${PROVIDER_PATH}.baseUrl (OpenAI-compatible ${OPENAI_COMPAT_PATH} endpoint)`,
      );
    }
  }

  if (
    typeof next.baseUrl === "string" &&
    next.baseUrl.includes(NATIVE_INFERENCE_PATH) &&
    isDeepInfraApiHost(next.baseUrl)
  ) {
    next.baseUrl = next.baseUrl.replace(NATIVE_INFERENCE_PATH, OPENAI_COMPAT_PATH);
    changes.push(`${PROVIDER_PATH}.baseUrl: ${NATIVE_INFERENCE_PATH} -> ${OPENAI_COMPAT_PATH}`);
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      models: {
        ...models,
        providers: { ...providers, deepinfra: next },
      } as unknown as OpenClawConfig["models"],
    },
    changes,
  };
}
