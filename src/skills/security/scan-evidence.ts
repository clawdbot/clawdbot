import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const LITERAL_SECRET_PATTERN =
  /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])|-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----\r?\n(?=(?:[A-Za-z0-9+/=]\r?\n?){48,}-----END \1-----)(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----/;

export const LITERAL_SECRET_SKILL_CONTENT_RULE = {
  ruleId: "literal-secret",
  severity: "critical",
  message: "Skill text contains a recognized literal credential",
  pattern: LITERAL_SECRET_PATTERN,
} as const;

function truncateEvidence(evidence: string, maxLen = 120): string {
  if (evidence.length <= maxLen) {
    return evidence;
  }
  return `${truncateUtf16Safe(evidence, maxLen)}…`;
}

export function formatScanEvidence(evidence: string): string {
  const normalized = evidence.trim();
  return LITERAL_SECRET_PATTERN.test(normalized)
    ? "[REDACTED CREDENTIAL]"
    : truncateEvidence(normalized);
}
