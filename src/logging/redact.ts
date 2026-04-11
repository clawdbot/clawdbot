import type { OpenClawConfig } from "../config/types.openclaw.js";
import { compileConfigRegex } from "../security/config-regex.js";
import { resolveNodeRequireFromMeta } from "./node-require.js";
import { replacePatternBounded } from "./redact-bounded.js";

const requireConfig = resolveNodeRequireFromMeta(import.meta.url);

export type RedactSensitiveMode = "off" | "tools";
type RedactPattern = string | RegExp;

const DEFAULT_REDACT_MODE: RedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

const DEFAULT_REDACT_PATTERNS: string[] = [
  // ENV-style assignments.
  String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
  // JSON fields.
  String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"`,
  // CLI flags.
  String.raw`--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
  // Authorization headers.
  String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
  String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
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
      redactMatch(args[0], args.slice(1, args.length - 2)),
    );
  }
  return next;
}

function resolveConfigRedaction(): RedactOptions {
  let cfg: OpenClawConfig["logging"] | undefined;
  try {
    const loaded = requireConfig?.("../config/config.js") as
      | {
          loadConfig?: () => OpenClawConfig;
        }
      | undefined;
    cfg = loaded?.loadConfig?.().logging;
  } catch {
    cfg = undefined;
  }
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
