const INCOGNITO_SESSION_RE = /^(?:dashboard|subagent|internal-session-effects):incognito-[^:]+$/u;

/** Classifies process-only agent session keys without consulting runtime registry state. */
export function isIncognitoSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = sessionKey?.trim().toLowerCase();
  if (!raw) {
    return false;
  }
  const parts = raw.split(":");
  if (parts.length < 3 || parts[0] !== "agent" || !parts[1]) {
    return false;
  }
  return INCOGNITO_SESSION_RE.test(parts.slice(2).join(":"));
}
