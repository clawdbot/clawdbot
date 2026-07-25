import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { formatCliCommand } from "../../cli/command-format.js";
/**
 * OAuth refresh failure classification and operator hints.
 * Parses provider/reason codes from refresh failures and formats safe login
 * commands without trusting raw provider text.
 */
import { formatInlineCodeSpan } from "../../shared/markdown-code.js";

export type OAuthRefreshFailureReason =
  | "refresh_token_reused"
  | "invalid_grant"
  | "sign_in_again"
  | "invalid_refresh_token"
  | "token_invalidated"
  | "revoked";

type OAuthRefreshFailure = {
  provider: string | null;
  profileId?: string;
  reason: OAuthRefreshFailureReason | null;
};

type StructuredClaudeCliAuthFailure = {
  provider?: unknown;
  rawError?: unknown;
  reason?: unknown;
  status?: unknown;
};

/** Error type that carries provider and classified OAuth refresh failure reason. */
export class OAuthRefreshFailureError extends Error {
  readonly provider: string;
  readonly profileId?: string;
  readonly reason: OAuthRefreshFailureReason | null;

  constructor(params: { provider: string; profileId?: string; message: string; cause?: unknown }) {
    super(params.message, { cause: params.cause });
    this.name = "OAuthRefreshFailureError";
    this.provider = params.provider;
    this.profileId = params.profileId;
    this.reason = classifyOAuthRefreshFailureReason(params.message);
  }
}

const OAUTH_REFRESH_FAILURE_PROVIDER_RE = /OAuth token refresh failed for ([^:]+):/i;
const SAFE_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
// Matches the error surfaced via FailoverError when the `claude` subprocess
// has an expired/invalid OAuth token.  The message always includes the
// "claude-cli" provider prefix (injected by the failover layer) and the
// literal 401 status plus Anthropic's "Invalid authentication credentials"
// phrase, so the pattern is narrow enough to avoid false-positives from
// unrelated provider 401 failures.
const CLAUDE_CLI_AUTH_FAILURE_RE =
  /\bclaude-cli\b.+?\b(failed to authenticate|401\s+invalid authentication credentials)\b/is;

function isClaudeCliExpiredOAuthMessage(message: string): boolean {
  return CLAUDE_CLI_AUTH_FAILURE_RE.test(message);
}

function readStructuredClaudeCliAuthFailure(err: unknown): StructuredClaudeCliAuthFailure | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const candidate = err as StructuredClaudeCliAuthFailure & { name?: unknown };
  if (
    candidate.name !== "FailoverError" ||
    candidate.provider !== "claude-cli" ||
    candidate.reason !== "auth" ||
    candidate.status !== 401
  ) {
    return null;
  }
  return candidate;
}

function classifyStructuredClaudeCliOAuthFailureReason(
  err: unknown,
): OAuthRefreshFailureReason | null {
  const failure = readStructuredClaudeCliAuthFailure(err);
  if (!failure) {
    return null;
  }
  const rawError = typeof failure.rawError === "string" ? failure.rawError : "";
  const message = err instanceof Error ? err.message : "";
  const combined = `${message}\n${rawError}`;
  const lower = combined.toLowerCase();
  if (/\bnot logged in\b\s*·\s*please run \/login\b/i.test(combined)) {
    return "sign_in_again";
  }
  const hasExpiredTokenSignal =
    lower.includes("failed to authenticate") ||
    lower.includes("invalid authentication credentials");
  return hasExpiredTokenSignal ? "revoked" : null;
}

function isOAuthRefreshFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("oauth token refresh failed") ||
    lower.includes("access token could not be refreshed") ||
    lower.includes("authentication session could not be refreshed automatically") ||
    isClaudeCliExpiredOAuthMessage(message)
  );
}

function extractOAuthRefreshFailureProvider(message: string): string | null {
  if (isClaudeCliExpiredOAuthMessage(message)) {
    // The message was produced by the claude-cli subprocess; the provider is
    // statically known — no need to parse it from the error text.
    return "claude-cli";
  }
  const provider = message.match(OAUTH_REFRESH_FAILURE_PROVIDER_RE)?.[1]?.trim();
  return provider && provider.length > 0 ? provider : null;
}

function sanitizeOAuthRefreshFailureProvider(provider: string | null | undefined): string | null {
  // Only return normalized provider ids that are safe to embed in shell guidance.
  const sanitized = provider ? sanitizeForLog(provider).replaceAll("`", "").trim() : "";
  const normalized = normalizeProviderId(sanitized);
  return normalized && SAFE_PROVIDER_ID_RE.test(normalized) ? normalized : null;
}

function sanitizeOAuthRefreshFailureProfileId(profileId: string | null | undefined): string | null {
  const sanitized = profileId ? sanitizeForLog(profileId).trim() : "";
  return sanitized || null;
}

function quoteShellArg(value: string): string {
  const escaped =
    process.platform === "win32" ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}

/** Wrap a rendered login command in a Markdown code span that survives embedded backticks. */
export function formatOAuthRefreshFailureLoginCommandMarkdown(command: string): string {
  return formatInlineCodeSpan(command);
}

/** Classify a raw OAuth refresh failure message into a stable reason code. */
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
  if (lower.includes("token_invalidated")) {
    return "token_invalidated";
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
  if (isClaudeCliExpiredOAuthMessage(message)) {
    // The claude subprocess emits "401 Invalid authentication credentials"
    // when its stored OAuth token has expired.  Map this to "revoked" so the
    // caller surfaces the targeted re-auth hint rather than the generic login
    // failure copy.
    return "revoked";
  }
  return null;
}

/** Classify provider/reason from a user-facing OAuth refresh failure message. */
export function classifyOAuthRefreshFailure(message: string): OAuthRefreshFailure | null {
  if (!isOAuthRefreshFailureMessage(message)) {
    return null;
  }
  return {
    provider: sanitizeOAuthRefreshFailureProvider(extractOAuthRefreshFailureProvider(message)),
    reason: classifyOAuthRefreshFailureReason(message),
  };
}

/** Classify provider/reason from the structured OAuth refresh failure error. */
export function classifyOAuthRefreshFailureError(err: unknown): OAuthRefreshFailure | null {
  const seen = new Set<object>();
  let candidate = err;
  while (candidate && typeof candidate === "object") {
    const claudeCliReason = classifyStructuredClaudeCliOAuthFailureReason(candidate);
    if (claudeCliReason) {
      return {
        provider: "claude-cli",
        reason: claudeCliReason,
      };
    }
    if (candidate instanceof OAuthRefreshFailureError) {
      const profileId = sanitizeOAuthRefreshFailureProfileId(candidate.profileId);
      return {
        provider: sanitizeOAuthRefreshFailureProvider(candidate.provider),
        ...(profileId ? { profileId } : {}),
        reason: candidate.reason,
      };
    }
    if (seen.has(candidate)) {
      return null;
    }
    seen.add(candidate);
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return null;
}

/** Build the login command operators should run after OAuth refresh failure. */
export function buildOAuthRefreshFailureLoginCommand(
  provider: string | null | undefined,
  options?: { profileId?: string | null },
): string {
  const sanitizedProvider = sanitizeOAuthRefreshFailureProvider(provider);
  const sanitizedProfileId = sanitizeOAuthRefreshFailureProfileId(options?.profileId);
  if (sanitizedProvider === "claude-cli") {
    // claude-cli is not a standalone provider id; it is the Anthropic provider
    // accessed via the CLI auth method. Refresh the local Claude CLI session
    // first, then re-register that auth method with OpenClaw.
    const claudeLoginCommand = formatCliCommand("claude auth login");
    const openclawLoginCommand = formatCliCommand(
      sanitizedProfileId
        ? `openclaw models auth login --provider anthropic --method cli --profile-id ${quoteShellArg(sanitizedProfileId)}`
        : "openclaw models auth login --provider anthropic --method cli",
    );
    return `${claudeLoginCommand} && ${openclawLoginCommand}`;
  }
  return sanitizedProvider
    ? formatCliCommand(
        sanitizedProfileId
          ? `openclaw models auth login --provider ${sanitizedProvider} --profile-id ${quoteShellArg(sanitizedProfileId)}`
          : `openclaw models auth login --provider ${sanitizedProvider}`,
      )
    : formatCliCommand("openclaw models auth login");
}
