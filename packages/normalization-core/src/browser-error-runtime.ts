import { formatErrorMessage as formatSharedErrorMessage } from "./error-coercion.js";

const BROWSER_ERROR_CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer|Basic|Bot)\s+[-A-Za-z0-9._~+/=]{8,}/giu, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[redacted]"],
  [
    /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|xai-[A-Za-z0-9]{30,})\b/gu,
    "[redacted]",
  ],
  [
    /(^|[\s,{?&])(["']?)(api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|token|secret)\2(\s*[=:]\s*)(["'])([^"'\r\n]+)\5/giu,
    "$1$2$3$2$4$5[redacted]$5",
  ],
  [
    /(^|[\s,{?&])(["']?)(api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|token|secret)\2(\s*[=:]\s*)([^\s&,'"}]+)/giu,
    "$1$2$3$2$4[redacted]",
  ],
];

function redactBrowserErrorText(text: string): string {
  return BROWSER_ERROR_CREDENTIAL_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    text,
  );
}

// Browser bundles cannot load the host secret registry, so retain a bounded
// browser-safe baseline before an owning UI applies any additional policy.
export function formatErrorMessage(error: unknown): string {
  return formatSharedErrorMessage(error, { redact: redactBrowserErrorText });
}
