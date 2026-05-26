import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { normalizeProviderId } from "./model-selection.js";

const KEY_SPLIT_RE = /[\s,;]+/g;
const GOOGLE_LIVE_SINGLE_KEY = "OPENCLAW_LIVE_GEMINI_KEY";

const PROVIDER_PREFIX_OVERRIDES: Record<string, string> = {
  google: "GEMINI",
  "google-vertex": "GEMINI",
};

type ProviderApiKeyConfig = {
  liveSingle?: string;
  listVar?: string;
  primaryVar?: string;
  prefixedVar?: string;
  fallbackVars: string[];
};

type CollectProviderApiKeysOptions = {
  env?: NodeJS.ProcessEnv;
  providerEnvVars?: readonly string[];
};

const PROVIDER_API_KEY_CONFIG: Record<string, Omit<ProviderApiKeyConfig, "fallbackVars">> = {
  anthropic: {
    liveSingle: "OPENCLAW_LIVE_ANTHROPIC_KEY",
    listVar: "OPENCLAW_LIVE_ANTHROPIC_KEYS",
    primaryVar: "ANTHROPIC_API_KEY",
    prefixedVar: "ANTHROPIC_API_KEY_",
  },
  google: {
    liveSingle: GOOGLE_LIVE_SINGLE_KEY,
    listVar: "GEMINI_API_KEYS",
    primaryVar: "GEMINI_API_KEY",
    prefixedVar: "GEMINI_API_KEY_",
  },
  "google-vertex": {
    liveSingle: GOOGLE_LIVE_SINGLE_KEY,
    listVar: "GEMINI_API_KEYS",
    primaryVar: "GEMINI_API_KEY",
    prefixedVar: "GEMINI_API_KEY_",
  },
  openai: {
    liveSingle: "OPENCLAW_LIVE_OPENAI_KEY",
    listVar: "OPENAI_API_KEYS",
    primaryVar: "OPENAI_API_KEY",
    prefixedVar: "OPENAI_API_KEY_",
  },
};

function parseKeyList(raw?: string | null): string[] {
  if (!raw) {
    return [];
  }
  return normalizeStringEntries(raw.split(KEY_SPLIT_RE));
}

function collectEnvPrefixedKeys(prefix: string, env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
      continue;
    }
    keys.push(trimmed);
  }
  return keys;
}

function resolveProviderApiKeyConfig(provider: string): ProviderApiKeyConfig {
  const normalized = normalizeProviderId(provider);
  const custom = PROVIDER_API_KEY_CONFIG[normalized];
  const base = PROVIDER_PREFIX_OVERRIDES[normalized] ?? normalized.toUpperCase().replace(/-/g, "_");

  const liveSingle = custom?.liveSingle ?? `OPENCLAW_LIVE_${base}_KEY`;
  const listVar = custom?.listVar ?? `${base}_API_KEYS`;
  const primaryVar = custom?.primaryVar ?? `${base}_API_KEY`;
  const prefixedVar = custom?.prefixedVar ?? `${base}_API_KEY_`;

  if (normalized === "google" || normalized === "google-vertex") {
    return {
      liveSingle,
      listVar,
      primaryVar,
      prefixedVar,
      fallbackVars: ["GOOGLE_API_KEY"],
    };
  }

  return {
    liveSingle,
    listVar,
    primaryVar,
    prefixedVar,
    fallbackVars: [],
  };
}

export function collectProviderApiKeys(
  provider: string,
  options: CollectProviderApiKeysOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const normalizedProvider = normalizeProviderId(provider);
  const config = resolveProviderApiKeyConfig(normalizedProvider);

  const forcedSingle = config.liveSingle
    ? normalizeOptionalString(env[config.liveSingle])
    : undefined;
  if (forcedSingle) {
    return [forcedSingle];
  }

  const fromList = parseKeyList(config.listVar ? env[config.listVar] : undefined);
  const primary = config.primaryVar ? normalizeOptionalString(env[config.primaryVar]) : undefined;
  const fromPrefixed = config.prefixedVar ? collectEnvPrefixedKeys(config.prefixedVar, env) : [];

  const fallback = config.fallbackVars
    .map((envVar) => normalizeOptionalString(env[envVar]))
    .filter(Boolean) as string[];
  const manifestEnvVars = options.providerEnvVars ?? getProviderEnvVars(normalizedProvider);
  const manifestFallback = manifestEnvVars
    .map((envVar) => normalizeOptionalString(env[envVar]))
    .filter(Boolean) as string[];

  const seen = new Set<string>();

  const add = (value?: string) => {
    if (!value) {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
  };

  for (const value of fromList) {
    add(value);
  }
  add(primary);
  for (const value of fromPrefixed) {
    add(value);
  }
  for (const value of fallback) {
    add(value);
  }
  for (const value of manifestFallback) {
    add(value);
  }

  return Array.from(seen);
}

export function collectAnthropicApiKeys(): string[] {
  return collectProviderApiKeys("anthropic");
}

export function collectGeminiApiKeys(): string[] {
  return collectProviderApiKeys("google");
}

export function isApiKeyRateLimitError(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  if (lower.includes("rate_limit")) {
    return true;
  }
  if (lower.includes("rate limit")) {
    return true;
  }
  if (lower.includes("429")) {
    return true;
  }
  if (lower.includes("quota exceeded") || lower.includes("quota_exceeded")) {
    return true;
  }
  if (lower.includes("resource exhausted") || lower.includes("resource_exhausted")) {
    return true;
  }
  if (lower.includes("too many requests")) {
    return true;
  }
  return false;
}

export function isAnthropicRateLimitError(message: string): boolean {
  return isApiKeyRateLimitError(message);
}

export function isAnthropicBillingError(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  if (lower.includes("credit balance")) {
    return true;
  }
  if (lower.includes("insufficient credit")) {
    return true;
  }
  if (lower.includes("insufficient credits")) {
    return true;
  }
  if (lower.includes("payment required")) {
    return true;
  }
  if (lower.includes("billing") && lower.includes("disabled")) {
    return true;
  }
  if (
    /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\spayment/i.test(
      lower,
    )
  ) {
    return true;
  }
  return false;
}
