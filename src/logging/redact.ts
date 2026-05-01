import { compileConfigRegex } from "../security/config-regex.js";
import { readLoggingConfig } from "./config.js";
import { replacePatternBounded } from "./redact-bounded.js";

export type RedactSensitiveMode = "off" | "tools";
type RedactPattern = string | RegExp;

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

const PAYMENT_CREDENTIAL_ENV_KEYS = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`;
const PAYMENT_CREDENTIAL_QUERY_KEYS = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`;
const PAYMENT_CREDENTIAL_JSON_KEYS = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`;
const STRUCTURED_SECRET_FIELD_RE = new RegExp(
  String.raw`^(?:api[-_]?key|apiKey|token|secret|password|passwd|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|client[-_]?secret|clientSecret|${PAYMENT_CREDENTIAL_QUERY_KEYS}|${PAYMENT_CREDENTIAL_JSON_KEYS})$`,
  "i",
);

const DEFAULT_REDACT_PATTERNS: string[] = [
  // ENV-style assignments. Keep this case-sensitive so diagnostics like
  // `Unrecognized key: "llm"` do not lose the actual config key.
  String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`,
  // URL query parameters. Keep this separate from ENV-style assignments so
  // lower-case URL secrets stay redacted without hiding config-key diagnostics.
  String.raw`/[?&](?:access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature|${PAYMENT_CREDENTIAL_QUERY_KEYS})=([^&\s"'<>]+)/gi`,
  // JSON fields.
  String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken|${PAYMENT_CREDENTIAL_JSON_KEYS})"\s*:\s*"([^"]+)"`,
  // CLI flags.
  String.raw`--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS})\s+(["']?)([^\s"']+)\1`,
  // Authorization headers.
  String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
  String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
  // Standalone token assignments in CLI or HTTP diagnostics. URL query params
  // are handled above so non-secret params survive and long values stay hinted.
  String.raw`(^|[\s,;])(?:access_token|refresh_token|api[-_]?key|token|secret|password|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS})=([^\s&#]+)`,
  // PEM blocks.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
  // Common token prefixes.
  String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
  String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
  String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
  String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
  String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
  String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
  String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
  // Additional access-key and token-style prefixes.
  String.raw`\b(AKID[A-Za-z0-9]{10,})\b`,
  String.raw`\b(LTAI[A-Za-z0-9]{10,})\b`,
  String.raw`\b(hf_[A-Za-z0-9]{10,})\b`,
  String.raw`\b(r8_[A-Za-z0-9]{10,})\b`,
  // Telegram Bot API URLs embed the token as `/bot<token>/...` (no word-boundary before digits).
  String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
  String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
];

type RedactOptions = {
  mode?: RedactSensitiveMode;
  patterns?: RedactPattern[];
};

export type ResolvedRedactOptions = {
  mode: RedactSensitiveMode;
  patterns: RegExp[];
};

function normalizeMode(value?: string): RedactSensitiveMode {
  return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: RedactPattern): RegExp | null {
  if (raw instanceof RegExp) {
    if (raw.flags.includes("g")) {
      return raw;
    }
    return new RegExp(raw.source, `${raw.flags}g`);
  }
  if (!raw.trim()) {
    return null;
  }
  const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
    return compileConfigRegex(match[1], flags)?.regex ?? null;
  }
  return compileConfigRegex(raw, "gi")?.regex ?? null;
}

function resolvePatterns(value?: RedactPattern[]): RegExp[] {
  const source = value?.length ? value : DEFAULT_REDACT_PATTERNS;
  return source.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function maskToken(token: string): string {
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = token.slice(0, DEFAULT_REDACT_KEEP_START);
  const end = token.slice(-DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const token = groups.findLast((value) => typeof value === "string" && value.length > 0) ?? match;
  const masked = maskToken(token);
  if (token === match) {
    return masked;
  }
  return match.replace(token, masked);
}

function redactText(text: string, patterns: RegExp[]): string {
  let next = text;
  for (const pattern of patterns) {
    next = replacePatternBounded(next, pattern, (...args: string[]) =>
      redactMatch(args[0], args.slice(1, -2)),
    );
  }
  return next;
}

function resolveConfigRedaction(): RedactOptions {
  const cfg = readLoggingConfig();
  return {
    mode: normalizeMode(cfg?.redactSensitive),
    patterns: cfg?.redactPatterns,
  };
}

export function resolveRedactOptions(options?: RedactOptions): ResolvedRedactOptions {
  const resolved = options ?? resolveConfigRedaction();
  const mode = normalizeMode(resolved.mode);
  if (mode === "off") {
    return {
      mode,
      patterns: [],
    };
  }
  return {
    mode,
    patterns: resolvePatterns(resolved.patterns),
  };
}

export function redactSensitiveText(text: string, options?: RedactOptions): string {
  if (!text) {
    return text;
  }
  const resolved = resolveRedactOptions(options);
  if (resolved.mode === "off") {
    return text;
  }
  if (!resolved.patterns.length) {
    return text;
  }
  return redactText(text, resolved.patterns);
}

export function redactToolDetail(detail: string): string {
  const resolved = resolveConfigRedaction();
  if (normalizeMode(resolved.mode) !== "tools") {
    return detail;
  }
  return redactSensitiveText(detail, resolved);
}

// Forces tools-mode regardless of `logging.redactSensitive` (which governs log
// output, not UI surfaces), and merges user `logging.redactPatterns` with the
// built-in defaults so both apply.
export function redactToolPayloadText(text: string): string {
  if (!text) {
    return text;
  }
  const cfg = readLoggingConfig();
  const userPatterns = cfg?.redactPatterns;
  const patterns =
    userPatterns && userPatterns.length > 0
      ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS]
      : undefined;
  return redactSensitiveText(text, { mode: "tools", patterns });
}

export function redactSensitiveFieldValue(key: string, value: string): string {
  const redacted = redactToolPayloadText(value);
  if (redacted !== value) {
    return redacted;
  }
  if (STRUCTURED_SECRET_FIELD_RE.test(key)) {
    return maskToken(value);
  }
  return value;
}

export function getDefaultRedactPatterns(): string[] {
  return [...DEFAULT_REDACT_PATTERNS];
}

// Applies already-resolved redaction to a batch of lines without re-resolving options.
// Lines are joined before redacting so multiline patterns (e.g. PEM blocks) can match across
// line boundaries, then split back. Use this instead of mapping redactSensitiveText when
// options are resolved once per request.
export function redactSensitiveLines(lines: string[], resolved: ResolvedRedactOptions): string[] {
  if (resolved.mode === "off" || !resolved.patterns.length || lines.length === 0) {
    return lines;
  }
  return redactText(lines.join("\n"), resolved.patterns).split("\n");
}
