import { formatCliCommand } from "../../cli/command-format.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { normalizeProviderId } from "../provider-id.js";

export type OAuthRefreshFailureReason =
  | "refresh_token_reused"
  | "invalid_grant"
  | "sign_in_again"
  | "invalid_refresh_token"
  | "revoked";

const OAUTH_REFRESH_FAILURE_PROVIDER_RE = /OAuth token refresh failed for ([^:]+):/i;
const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function extractOAuthRefreshFailureProvider(message: string): string | null {
  const provider = message.match(OAUTH_REFRESH_FAILURE_PROVIDER_RE)?.[1]?.trim();
  return provider && provider.length > 0 ? provider : null;
}

function sanitizeOAuthRefreshFailureProvider(provider: string | null | undefined): string | null {
  const sanitized = provider ? sanitizeForLog(provider).replaceAll("`", "").trim() : "";
  const normalized = normalizeProviderId(sanitized);
  return normalized && SAFE_PROVIDER_ID_RE.test(normalized) ? normalized : null;
}

export function classifyOAuthRefreshFailureReason(
  message: string,
): OAuthRefreshFailureReason | null {
  const lower = message.toLowerCase();
  if (lower.includes("refresh_token_reused")) {
    return "refresh_token_reused";
  }
  if (lower.includes("invalid_grant")) {
    return "invalid_grant";
  }
  if (lower.includes("signing in again") || lower.includes("sign in again")) {
    return "sign_in_again";
  }
  if (lower.includes("invalid refresh token")) {
    return "invalid_refresh_token";
  }
  if (lower.includes("expired or revoked") || lower.includes("revoked")) {
    return "revoked";
  }
  return null;
}

export function classifyOAuthRefreshFailure(message: string): {
  provider: string | null;
  reason: OAuthRefreshFailureReason | null;
} | null {
  if (!/oauth token refresh failed/i.test(message)) {
    return null;
  }
  return {
    provider: sanitizeOAuthRefreshFailureProvider(extractOAuthRefreshFailureProvider(message)),
    reason: classifyOAuthRefreshFailureReason(message),
  };
}

export function buildOAuthRefreshFailureLoginCommand(provider: string | null | undefined): string {
  const safeProvider = sanitizeOAuthRefreshFailureProvider(provider);
  return safeProvider
    ? formatCliCommand(`openclaw models auth login --provider ${safeProvider}`)
    : formatCliCommand("openclaw models auth login");
}
