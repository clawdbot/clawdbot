import { resolveExpiresAtMsFromEpochSeconds } from "../../packages/normalization-core/src/number-coercion.js";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";

const OPENAI_CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_CODEX_PROFILE_CLAIM = "https://api.openai.com/profile";

export type OpenAICodexAuthIdentity = {
  accountId?: string;
  chatgptPlanType?: string;
  email?: string;
  profileName?: string;
};

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

export function resolveOpenAICodexAuthIdentity(params: {
  access: string;
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

export function resolveOpenAICodexAccessTokenExpiry(access: string): number | undefined {
  const payload = decodeOpenAICodexJwtPayload(access);
  const exp = payload?.exp;
  return resolveExpiresAtMsFromEpochSeconds(exp);
}

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

export function resolveOpenAICodexImportProfileName(
  identity: Pick<OpenAICodexAuthIdentity, "accountId" | "profileName">,
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
