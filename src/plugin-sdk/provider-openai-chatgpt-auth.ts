// OpenAI ChatGPT auth helpers normalize OAuth session data for provider plugins.
import { resolveExpiresAtMsFromEpochSeconds } from "../../packages/normalization-core/src/number-coercion.js";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";

const OPENAI_CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_CODEX_PROFILE_CLAIM = "https://api.openai.com/profile";

/**
 * Identity metadata extracted from OpenAI Codex ChatGPT OAuth tokens.
 */
export type OpenAICodexAuthIdentity = {
  /**
   * ChatGPT account id used to group imported profiles under the same account.
   */
  accountId?: string;
  /**
   * ChatGPT subscription plan claim captured for diagnostics and credential metadata.
   */
  chatgptPlanType?: string;
  /**
   * Profile email from the OpenAI token profile claim when available.
   */
  email?: string;
  /**
   * Stable local profile name derived from email, account-scoped subject, or fallback id.
   */
  profileName?: string;
};

/**
 * Decodes a JWT payload without verifying signatures for local metadata extraction.
 */
export function decodeOpenAICodexJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolves stable account/profile metadata from OpenAI Codex OAuth access-token claims.
 */
export function resolveOpenAICodexAuthIdentity(params: {
  /**
   * OpenAI Codex OAuth access token containing ChatGPT auth/profile claims.
   */
  access: string;
  /**
   * Account id supplied by the import source when the access token omits one.
   */
  accountId?: string;
}): OpenAICodexAuthIdentity {
  const payload = decodeOpenAICodexJwtPayload(params.access);
  const auth = readRecord(payload?.[OPENAI_CODEX_AUTH_CLAIM]);
  const profile = readRecord(payload?.[OPENAI_CODEX_PROFILE_CLAIM]);
  const email = normalizeOptionalString(profile.email);
  const accountId = params.accountId ?? normalizeOptionalString(auth.chatgpt_account_id);
  const chatgptPlanType = normalizeOptionalString(auth.chatgpt_plan_type);
  if (email) {
    return {
      ...(accountId ? { accountId } : {}),
      ...(chatgptPlanType ? { chatgptPlanType } : {}),
      email,
      profileName: email,
    };
  }

  const stableSubject =
    // Prefer account-scoped user ids over generic JWT subject so imports keep
    // profile names stable across token refreshes and provider migrations.
    normalizeOptionalString(auth.chatgpt_account_user_id) ??
    normalizeOptionalString(auth.chatgpt_user_id) ??
    normalizeOptionalString(auth.user_id) ??
    normalizeOptionalString(payload?.sub) ??
    accountId;
  return {
    ...(accountId ? { accountId } : {}),
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
    ...(stableSubject
      ? { profileName: `id-${Buffer.from(stableSubject).toString("base64url")}` }
      : {}),
  };
}

/**
 * Resolves the OAuth access-token expiry timestamp in milliseconds.
 */
export function resolveOpenAICodexAccessTokenExpiry(access: string): number | undefined {
  const payload = decodeOpenAICodexJwtPayload(access);
  const exp = payload?.exp;
  return resolveExpiresAtMsFromEpochSeconds(exp);
}

/**
 * Builds persisted credential metadata for OpenAI Codex OAuth profiles.
 */
export function buildOpenAICodexCredentialExtra(
  identity: OpenAICodexAuthIdentity & { idToken?: string },
): Record<string, unknown> | undefined {
  const extra = {
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    ...(identity.chatgptPlanType ? { chatgptPlanType: identity.chatgptPlanType } : {}),
    ...(identity.idToken ? { idToken: identity.idToken } : {}),
  };
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Picks the imported profile name used when migrating OpenAI Codex auth.
 */
export function resolveOpenAICodexImportProfileName(
  identity: Pick<OpenAICodexAuthIdentity, "accountId" | "profileName">,
  /**
   * Name to use when imported metadata does not contain an account or stable subject.
   */
  fallback: string,
): string {
  if (identity.accountId) {
    return `account-${identity.accountId.replaceAll(/[^A-Za-z0-9._-]+/gu, "-")}`;
  }
  if (identity.profileName?.startsWith("id-")) {
    return identity.profileName;
  }
  return fallback;
}
