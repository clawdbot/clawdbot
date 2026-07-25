// Msteams plugin module implements bot framework service url behavior.
import {
  isHttpsUrlAllowedByHostnameSuffixAllowlist,
  normalizeHostnameSuffixAllowlist,
} from "openclaw/plugin-sdk/ssrf-policy";

const DEFAULT_BOT_FRAMEWORK_SERVICE_URL_HOST_ALLOWLIST = [
  // Microsoft Teams Bot Framework serviceUrl endpoints documented for
  // commercial, GCC, GCC High, and DOD clouds. Azure China Bot Framework
  // documents *.botframework.azure.cn as the channel boundary for 21Vianet.
  // These are the only hosts that may receive Bot Framework service tokens.
  "smba.trafficmanager.net",
  "smba.infra.gcc.teams.microsoft.com",
  "smba.infra.gov.teams.microsoft.us",
  "smba.infra.dod.teams.microsoft.us",
  "botframework.azure.cn",
] as const;

const BOT_FRAMEWORK_SERVICE_URL_HOST_ALLOWLIST = normalizeHostnameSuffixAllowlist(
  DEFAULT_BOT_FRAMEWORK_SERVICE_URL_HOST_ALLOWLIST,
);

export function describeBotFrameworkServiceUrlHost(serviceUrl: string): string {
  try {
    const parsed = new URL(serviceUrl.trim());
    return parsed.hostname || "invalid-url";
  } catch {
    return "invalid-url";
  }
}

export function isAllowedBotFrameworkServiceUrl(serviceUrl: unknown): serviceUrl is string {
  if (typeof serviceUrl !== "string") {
    return false;
  }
  const trimmed = serviceUrl.trim();
  return Boolean(
    trimmed &&
    isHttpsUrlAllowedByHostnameSuffixAllowlist(trimmed, BOT_FRAMEWORK_SERVICE_URL_HOST_ALLOWLIST),
  );
}

export function tryNormalizeBotFrameworkServiceUrl(serviceUrl: unknown): string | undefined {
  if (!isAllowedBotFrameworkServiceUrl(serviceUrl)) {
    return undefined;
  }
  return serviceUrl.trim().replace(/\/+$/, "");
}

export function normalizeBotFrameworkServiceUrl(serviceUrl: string): string {
  const normalized = tryNormalizeBotFrameworkServiceUrl(serviceUrl);
  if (normalized) {
    return normalized;
  }
  throw new Error(
    `Blocked Microsoft Teams serviceUrl host: ${describeBotFrameworkServiceUrlHost(serviceUrl)}`,
  );
}
