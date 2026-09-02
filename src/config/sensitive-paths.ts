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
  "passwordFile",
] as const;

const NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES = SENSITIVE_KEY_WHITELIST_SUFFIXES.map((suffix) =>
  normalizeLowercaseStringOrEmpty(suffix),
);

const SENSITIVE_PATTERNS = [
  /token$/i,
  /password/i,
  /secret/i,
  /api.?key/i,
  /encrypt.?key/i,
  /private.?key/i,
  /serviceaccount(?:ref)?$/i,
];

function isWhitelistedSensitivePath(path: string): boolean {
  const lowerPath = normalizeLowercaseStringOrEmpty(path);
  return NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
}

function matchesSensitivePattern(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

function isLocalServiceEnvValuePath(path: string): boolean {
  const lowerPath = normalizeLowercaseStringOrEmpty(path);
  return lowerPath.includes("localservice.env.");
}

/**
 * Classifies config paths whose values should be redacted from UI/API output.
 *
 * This intentionally works from path labels, not schema nodes, so plugin-owned
 * fields and raw local-service env vars get the same conservative treatment.
 */
export function isSensitiveConfigPath(path: string): boolean {
  return (
    // Every local service env value is sensitive, even innocuous-looking names.
    isLocalServiceEnvValuePath(path) ||
    (!isWhitelistedSensitivePath(path) && matchesSensitivePattern(path))
  );
}
