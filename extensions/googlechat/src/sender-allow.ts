import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

function normalizeUserId(raw?: string | null): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^users\//i, ""));
}

function isEmailLike(value: string): boolean {
  // Keep this intentionally loose; allowlists are user-provided config.
  return value.includes("@");
}

export function isSenderAllowed(
  senderId: string,
  senderEmail: string | undefined,
  allowFrom: string[],
  allowNameMatching = false,
) {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeUserId(senderId);
  const normalizedEmail = normalizeLowercaseStringOrEmpty(senderEmail ?? "");
  return allowFrom.some((entry) => {
    const normalized = normalizeLowercaseStringOrEmpty(entry);
    if (!normalized) {
      return false;
    }

    // Accept `googlechat:<id>` but treat `users/...` as an *ID* only (deprecated `users/<email>`).
    const withoutPrefix = normalized.replace(/^(googlechat|google-chat|gchat):/i, "");
    if (withoutPrefix.startsWith("users/")) {
      return normalizeUserId(withoutPrefix) === normalizedSenderId;
    }

    // Raw email allowlist entries are a break-glass override.
    if (allowNameMatching && normalizedEmail && isEmailLike(withoutPrefix)) {
      return withoutPrefix === normalizedEmail;
    }

    return withoutPrefix.replace(/^users\//i, "") === normalizedSenderId;
  });
}
