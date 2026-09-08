import { isLoopbackHost } from "openclaw/plugin-sdk/request-url";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parse as parseToml } from "smol-toml";
import { CODEX_APP_SERVER_PROVIDER_ID_PATTERN } from "./config-contracts.js";

export type CodexCustomProviderBinding = { provider: string; baseUrl: string };

// The pinned stdio app-server disables CODEX_API_KEY account login; custom env_key
// still reads it as a workload bearer token. Keep the child value explicitly bound.
export const CODEX_CUSTOM_PROVIDER_API_KEY_ENV = "CODEX_API_KEY";

const RESERVED_PROVIDER_IDS = new Set(["codex", "openai"]);
const THREAD_ROUTE_CONFIG_KEYS = new Set([
  "model",
  "model_provider",
  "model_providers",
  "profile",
  "profiles",
  "openai_base_url",
  "chatgpt_base_url",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
  "cli_auth_credentials_store",
]);

export function normalizeCodexCustomProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const provider = value.trim().toLowerCase();
  return CODEX_APP_SERVER_PROVIDER_ID_PATTERN.test(provider) && !RESERVED_PROVIDER_IDS.has(provider)
    ? provider
    : undefined;
}

export function normalizeCodexCustomProviderBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const input = value.trim();
  if (!/^https?:\/\//i.test(input) || /[\s?#]/.test(input) || /^https?:\/\/[^/]*@/i.test(input)) {
    return undefined;
  }
  try {
    const url = new URL(input);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return undefined;
    }
    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      return undefined;
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** Validate the running server's selected provider before forwarding a workload. */
export function assertCodexCustomProviderEffectiveConfig(
  binding: CodexCustomProviderBinding,
  effectiveConfig: unknown,
): void {
  const baseUrl = normalizeCodexCustomProviderBaseUrl(binding.baseUrl);
  if (normalizeCodexCustomProviderId(binding.provider) !== binding.provider || !baseUrl) {
    throw new Error(
      "Codex custom provider binding requires a valid provider ID and HTTPS or loopback HTTP endpoint",
    );
  }
  const config = asOptionalRecord(effectiveConfig);
  const providers = asOptionalRecord(config?.model_providers);
  const provider =
    providers && Object.hasOwn(providers, binding.provider)
      ? asOptionalRecord(providers[binding.provider])
      : undefined;
  if (!provider) {
    throw new Error("Codex custom provider is missing from the running server's effective config");
  }
  if (normalizeCodexCustomProviderBaseUrl(provider.base_url) !== baseUrl) {
    throw new Error("Codex custom provider endpoint does not match the prepared OpenClaw route");
  }
  const shellPolicy = asOptionalRecord(config?.shell_environment_policy);
  const shellSet = asOptionalRecord(shellPolicy?.set);
  if (
    shellSet?.[CODEX_CUSTOM_PROVIDER_API_KEY_ENV] !== "" ||
    shellPolicy?.experimental_use_profile !== false ||
    asOptionalRecord(config?.features)?.shell_snapshot !== false ||
    config?.allow_login_shell !== false
  ) {
    throw new Error("Codex custom provider requires managed shell credential isolation");
  }
  // Codex 0.153.4 ModelProviderInfo defaults to Responses and requires_openai_auth=false.
  if (
    (provider.wire_api !== undefined && provider.wire_api !== "responses") ||
    (provider.requires_openai_auth !== undefined && provider.requires_openai_auth !== false) ||
    provider.env_key !== CODEX_CUSTOM_PROVIDER_API_KEY_ENV ||
    (provider.supports_websockets !== undefined && provider.supports_websockets !== false)
  ) {
    throw new Error(
      "Codex custom provider requires Responses, the managed API-key environment variable, and no OpenAI account auth or WebSockets",
    );
  }
  if (
    ["auth", "aws", "experimental_bearer_token"].some((key) => provider[key] != null) ||
    ["query_params", "http_headers", "env_http_headers"].some((key) => {
      const value = provider[key];
      if (value == null) {
        return false;
      }
      const record = asOptionalRecord(value);
      return !record || Object.keys(record).length > 0;
    })
  ) {
    throw new Error(
      "Codex custom provider contains unsupported auth or request transport overrides",
    );
  }
}

/** Final thread patches must not replace the provider snapshot validated at preflight. */
export function assertCodexCustomProviderThreadConfig(config: unknown): void {
  if (config == null) {
    return;
  }
  const record = asOptionalRecord(config);
  if (!record) {
    throw new Error("Codex custom provider thread config must be an object");
  }
  const replacesRoute = Object.keys(record).some((key) => {
    let roots: string[];
    try {
      // Codex interprets config keys as TOML paths, including quoted/escaped segments.
      const parsed = parseToml(`${key} = true`);
      roots = Object.keys(parsed);
      const features = asOptionalRecord(parsed.features);
      if (
        (Object.hasOwn(parsed, "shell_environment_policy") && key !== "shell_environment_policy") ||
        (Object.hasOwn(parsed, "allow_login_shell") && key !== "allow_login_shell") ||
        (Object.hasOwn(parsed, "features") && !features && key !== "features") ||
        (features && Object.hasOwn(features, "shell_snapshot") && key !== "features.shell_snapshot")
      ) {
        throw new Error("Ambiguous shell credential policy override");
      }
    } catch {
      throw new Error("Codex custom provider thread config contains an invalid config key");
    }
    return roots.some((root) => THREAD_ROUTE_CONFIG_KEYS.has(root));
  });
  if (replacesRoute) {
    throw new Error(
      "Codex custom provider thread config cannot override model routing or authentication",
    );
  }
}

export function assertCodexCustomProviderResponse(
  binding: CodexCustomProviderBinding,
  modelProvider: unknown,
): void {
  if (modelProvider !== binding.provider) {
    throw new Error(
      "Codex returned a different provider than the prepared custom provider binding",
    );
  }
}
