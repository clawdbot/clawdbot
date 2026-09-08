// Classifies sensitive config paths for redaction and validation.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/**
 * Non-sensitive field names that happen to match sensitive patterns.
 * These are explicitly excluded from redaction (plugin config) and
 * warnings about not being marked sensitive (base config).
 */
const SENSITIVE_KEY_WHITELIST_SUFFIXES = [
  "maxtokens",
  "maxoutputtokens",
  "maxinputtokens",
  "maxcompletiontokens",
  "contexttokens",
  "totaltokens",
  "tokencount",
  "tokenlimit",
  "tokenbudget",
  "passwordfile",
] as const;

const SENSITIVE_PATTERNS = [
  /token$/i,
  /password/i,
  /secret/i,
  /api.?key/i,
  /encrypt.?key/i,
  /private.?key/i,
  /serviceaccount(?:ref)?$/i,
];

/**
 * Classifies config paths whose values should be redacted from UI/API output.
 *
 * This intentionally works from path labels, not schema nodes, so plugin-owned
 * fields and raw local-service env vars get the same conservative treatment.
 */
export function isSensitiveConfigPath(path: string): boolean {
  const lowerPath = normalizeLowercaseStringOrEmpty(path);
  return (
    // Every local service env value is sensitive, even innocuous-looking names.
    lowerPath.includes("localservice.env.") ||
    (!SENSITIVE_KEY_WHITELIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix)) &&
      SENSITIVE_PATTERNS.some((pattern) => pattern.test(path)))
  );
}
