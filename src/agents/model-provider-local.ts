/** Shared local model-provider URL classification. */
import { isLoopbackIpAddress, isRfc1918Ipv4Address } from "@openclaw/net-policy/ip";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function isLocalProviderBaseUrl(
  baseUrl: string,
  additionalHostnames?: ReadonlySet<string>,
): boolean {
  try {
    let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      additionalHostnames?.has(host) === true ||
      isLoopbackIpAddress(host) ||
      isRfc1918Ipv4Address(host)
    );
  } catch {
    return false;
  }
}

export const SELF_HOSTED_PROVIDER_ID_PREFIXES = [
  "ollama",
  "lmstudio",
  "vllm",
  "sglang",
  "llama-cpp",
  "local",
];

export function isSelfHostedProviderId(provider: string | undefined): boolean {
  const normalized = provider?.trim().toLowerCase();
  if (!normalized || normalized === "ollama-cloud") {
    return false;
  }
  return SELF_HOSTED_PROVIDER_ID_PREFIXES.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix}-`) ||
      normalized.startsWith(`${prefix}_`),
  );
}
