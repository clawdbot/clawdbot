import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export const DEFAULT_TIMEOUT_MS = 5000;

export const PROVIDER_LABELS: Record<UsageProviderId, string> = {
  anthropic: "Claude",
  "github-copilot": "Copilot",
  "google-gemini-cli": "Gemini",
  minimax: "MiniMax",
  openai: "OpenAI",
  xiaomi: "Xiaomi",
  "xiaomi-token-plan": "Xiaomi Token Plan",
  zai: "z.ai",
};

export const usageProviders: UsageProviderId[] = [
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "minimax",
  "openai",
  "xiaomi",
  "xiaomi-token-plan",
  "zai",
];

export function isOAuthOnlyUsageProvider(provider: UsageProviderId): boolean {
  return provider === "openai";
}

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
  if (
    normalized === "minimax-portal" ||
    normalized === "minimax-cn" ||
    normalized === "minimax-portal-cn"
  ) {
    return "minimax";
  }
  return usageProviders.includes(normalized as UsageProviderId)
    ? (normalized as UsageProviderId)
    : undefined;
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
