import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export function normalizeProviderId(provider: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(provider);
  if (normalized === "modelstudio" || normalized === "qwencloud") {
    return "qwen";
  }
  if (normalized === "z.ai" || normalized === "z-ai") {
    return "zai";
  }
  if (normalized === "opencode-zen") {
    return "opencode";
  }
  if (normalized === "opencode-go-auth") {
    return "opencode-go";
  }
  if (normalized === "anthropic-cli") {
    return "claude-cli";
  }
  if (normalized === "kimi" || normalized === "kimi-code" || normalized === "kimi-coding") {
    return "kimi";
  }
  if (normalized === "moonshotai" || normalized === "moonshot-ai") {
    return "moonshot";
  }
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  // Backward compatibility for older provider naming.
  if (normalized === "bytedance" || normalized === "doubao") {
    return "volcengine";
  }
  return normalized;
}

/** Normalize provider ID before manifest-owned auth alias lookup. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderId(provider);
}

export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [key, value] of Object.entries(entries)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  if (!entries) {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  return Object.keys(entries).find((key) => normalizeProviderId(key) === providerKey);
}
