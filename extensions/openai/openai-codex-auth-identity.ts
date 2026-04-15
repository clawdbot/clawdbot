import { trimNonEmptyString } from "./openai-codex-shared.js";

type CodexJwtPayload = {
  exp?: unknown;
  iss?: unknown;
  sub?: unknown;
  "https://api.openai.com/profile"?: {
    email?: unknown;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_account_user_id?: unknown;
    chatgpt_user_id?: unknown;
    user_id?: unknown;
  };
};

function normalizeFutureEpochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

export function decodeCodexJwtPayload(accessToken: string): CodexJwtPayload | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as CodexJwtPayload) : null;
  } catch {
    return null;
  }
}

export function resolveCodexStableSubject(payload: CodexJwtPayload | null): string | undefined {
  const auth = payload?.["https://api.openai.com/auth"];
  const accountUserId = trimNonEmptyString(auth?.chatgpt_account_user_id);
  if (accountUserId) {
    return accountUserId;
  }

  const userId = trimNonEmptyString(auth?.chatgpt_user_id) ?? trimNonEmptyString(auth?.user_id);
  if (userId) {
    return userId;
  }

  const iss = trimNonEmptyString(payload?.iss);
  const sub = trimNonEmptyString(payload?.sub);
  if (iss && sub) {
    return `${iss}|${sub}`;
  }
  return sub;
}

export function resolveCodexAccessTokenExpiry(accessToken: string): number | undefined {
  const payload = decodeCodexJwtPayload(accessToken);
  const exp = normalizeFutureEpochSeconds(payload?.exp);
  return exp ? exp * 1000 : undefined;
}

export function resolveCodexAuthIdentity(params: { accessToken: string; email?: string | null }): {
  email?: string;
  profileName?: string;
} {
  const payload = decodeCodexJwtPayload(params.accessToken);
  const email =
    trimNonEmptyString(payload?.["https://api.openai.com/profile"]?.email) ??
    trimNonEmptyString(params.email);
  if (email) {
    return { email, profileName: email };
  }

  const stableSubject = resolveCodexStableSubject(payload);
  if (!stableSubject) {
    return {};
  }

  return {
    profileName: `id-${Buffer.from(stableSubject).toString("base64url")}`,
  };
}
