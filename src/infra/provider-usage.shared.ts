import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProviderId } from "../agents/provider-id.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export const DEFAULT_TIMEOUT_MS = 5000;

export const PROVIDER_LABELS: Record<UsageProviderId, string> = {
  anthropic: "Claude",
  "github-copilot": "Copilot",
  "google-gemini-cli": "Gemini",
  minimax: "MiniMax",
  "openai-codex": "Codex",
  xiaomi: "Xiaomi",
  zai: "z.ai",
};

export const usageProviders: UsageProviderId[] = [
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "minimax",
  "openai-codex",
  "xiaomi",
  "zai",
];

export function resolveUsageProviderId(provider?: string | null): UsageProviderId | undefined {
  if (!provider) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
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
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

function resolveLegacyPiAgentAuthPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveRequiredHomeDir(env, os.homedir), ".pi", "agent", "auth.json");
}

export function resolveLegacyPiAgentAccessToken(
  env: NodeJS.ProcessEnv,
  providerIds: string[],
): string | undefined {
  try {
    const authPath = resolveLegacyPiAgentAuthPath(env);
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
      string,
      { access?: string }
    >;
    for (const providerId of providerIds) {
      const token = parsed[providerId]?.access;
      if (typeof token === "string" && token.trim()) {
        return token;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
