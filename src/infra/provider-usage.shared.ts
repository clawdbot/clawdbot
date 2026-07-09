// Shared provider usage labels, ids, and timeout helpers.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import type { UsageProviderId } from "./provider-usage.types.js";

/** Default timeout for provider usage collection. */
export const DEFAULT_TIMEOUT_MS = 5000;

export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Claude",
  clawrouter: "ClawRouter",
  deepseek: "DeepSeek",
  "github-copilot": "Copilot",
  "google-gemini-cli": "Gemini",
  minimax: "MiniMax",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  venice: "Venice",
  xiaomi: "Xiaomi",
  "xiaomi-token-plan": "Xiaomi Token Plan",
  zai: "z.ai",
};

export function resolveProviderUsageDisplayName(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Returns true for providers whose usage endpoint is only meaningful with OAuth/token auth. */
export function isOAuthOnlyUsageProvider(provider: UsageProviderId): boolean {
  return provider === "openai";
}

/** Maps model/provider ids and credential type into a normalized usage provider id. */
export function resolveUsageProviderId(
  provider?: string | null,
  options?: { credentialType?: string | null },
): UsageProviderId | undefined {
  if (!provider) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  if (
    normalized === "openai" &&
    (options?.credentialType === "oauth" || options?.credentialType === "token")
  ) {
    return "openai";
  }
  if (normalized === "openai") {
    return undefined;
  }
  // Claude CLI-backed models bill against the same Anthropic subscription as
  // native anthropic OAuth; without this mapping claude-cli-only setups get
  // "Unsupported provider" instead of plan usage windows.
  if (normalized === "claude-cli") {
    return "anthropic";
  }
  if (
    normalized === "minimax-portal" ||
    normalized === "minimax-cn" ||
    normalized === "minimax-portal-cn"
  ) {
    return "minimax";
  }
  return normalized || undefined;
}

export const ignoredErrors = new Set([
  "No credentials",
  "No token",
  "No API key",
  "Not logged in",
  "No auth",
]);

export const clampPercent = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

/** Resolves a promise with a fallback when usage collection exceeds the timeout. */
export const withTimeout = async <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutMs = resolveTimerTimeoutMs(ms, 1);
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};
