/**
 * Payload redaction utilities for LLM-bound content.
 *
 * This module detects and replaces personally-identifiable information (PII)
 * in text before it leaves the machine as part of an LLM inference request.
 *
 * Design goals
 * ─────────────
 * 1. Zero false-positives over zero false-negatives — it is better to miss
 *    an occasional PII fragment than to corrupt valid technical content (e.g.
 *    UUIDs inside JSON tool outputs, IPv4 addresses in network diagnostics).
 * 2. Predictable replacements — each category gets a stable placeholder token
 *    so downstream text is still parseable.
 * 3. Opt-in — all redaction is disabled by default; users must set
 *    `privacy.enabled = true` in openclaw.yml.
 *
 * @module privacy/payload-redact
 */

import type { PiiCategoryRule, PrivacyConfig } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Patterns
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Named PII patterns used for detection.
 * Each pattern is compiled once and reused across calls.
 *
 * Ordering matters: more-specific patterns must come before less-specific ones
 * so that a match for "ssn" is not partially consumed by a weaker pattern.
 */
const PII_PATTERNS: Array<{
  category: keyof NonNullable<NonNullable<PrivacyConfig["pii"]>["categories"]>;
  defaultPlaceholder: string;
  regex: RegExp;
}> = [
  {
    // Social Security Numbers  (US)
    // Formats: 123-45-6789 | 123 45 6789
    // Note: 9-digit runs without separators are intentionally excluded to
    // avoid false-positives on arbitrary numeric IDs.
    category: "ssn",
    defaultPlaceholder: "[SSN]",
    regex: /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0{4})\d{4}\b/g,
  },
  {
    // Credit / debit card numbers (13-16 digits, optionally space/dash-grouped)
    // Covers: Visa (16), Mastercard (16), Discover (16), Amex (15), JCB (15-16)
    // Luhn validation is NOT performed here — too expensive for hot path.
    category: "creditCard",
    defaultPlaceholder: "[CARD]",
    regex:
      /\b(?:4\d{3}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}|5[1-5]\d{2}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}|6(?:011|5\d{2})[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}|3[47]\d{2}[- ]?\d{6}[- ]?\d{5}|(?:2131|1800|35\d{3})[- ]?\d{4}[- ]?\d{4}[- ]?\d{3,4})\b/g,
  },
  {
    // Email addresses
    category: "email",
    defaultPlaceholder: "[EMAIL]",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    // Phone numbers — intentionally broad to catch international formats.
    // Excludes pure numeric strings that look like phone numbers but are
    // preceded by common technical tokens (port, pid, etc.).
    category: "phone",
    defaultPlaceholder: "[PHONE]",
    regex:
      /(?<![:/=])\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)(?!\s*(?:ms|px|pt|em|rem|s\b))/g,
  },
  {
    // IPv4 addresses
    category: "ipv4",
    defaultPlaceholder: "[IPv4]",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b(?!\/\d)/g,
  },
  {
    // UUIDs (v1–v5)
    category: "uuid",
    defaultPlaceholder: "[UUID]",
    regex:
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g,
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type RedactionStats = {
  /** Total number of replacements made across all categories. */
  totalReplacements: number;
  /** Per-category replacement counts. */
  byCategory: Partial<Record<string, number>>;
};

export type RedactionResult = {
  text: string;
  stats: RedactionStats;
};

// ──────────────────────────────────────────────────────────────────────────────
// Core redaction
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Apply PII redaction to a single string.
 *
 * @param text - The string to redact.
 * @param config - The privacy config section.  If absent or disabled, the
 *                 original string is returned unchanged.
 * @returns The redacted string and per-category replacement statistics.
 */
export function redactPii(text: string, config?: PrivacyConfig): RedactionResult {
  const noOp: RedactionResult = { text, stats: { totalReplacements: 0, byCategory: {} } };

  // pii.enabled defaults to true when privacy.enabled=true (per documented contract)
  if (!config?.enabled || config.pii?.enabled === false) {
    return noOp;
  }

  let result = text;
  const byCategory: Partial<Record<string, number>> = {};
  let totalReplacements = 0;

  for (const { category, defaultPlaceholder, regex } of PII_PATTERNS) {
    const categoryRule: PiiCategoryRule | undefined = config.pii?.categories?.[category];

    // Allow per-category opt-out even when global pii.enabled=true
    if (categoryRule?.redact === false) {
      continue;
    }

    const placeholder = categoryRule?.placeholder ?? defaultPlaceholder;

    // Reset lastIndex — patterns use the /g flag so they must be reset
    // before each call to avoid stateful carryover across invocations.
    regex.lastIndex = 0;

    const before = result;
    result = result.replace(regex, placeholder);

    if (result !== before) {
      // Count matches by comparing lengths (approximate but allocation-free)
      // A more precise count would require exec() in a loop — fine for stats.
      const count = (before.match(regex) ?? []).length;
      byCategory[category] = (byCategory[category] ?? 0) + count;
      totalReplacements += count;
    }

    // Reset again after replace() (replace resets lastIndex, but be explicit)
    regex.lastIndex = 0;
  }

  return { text: result, stats: { totalReplacements, byCategory } };
}

/**
 * Convenience wrapper that returns just the redacted string.
 * Useful in call-sites that don't care about stats.
 */
export function redactPiiText(text: string, config?: PrivacyConfig): string {
  return redactPii(text, config).text;
}

// ──────────────────────────────────────────────────────────────────────────────
// Runtime line masking
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Apply hostname/OS/path masking to a fully-built Runtime line.
 *
 * This is called *after* `buildRuntimeLine()` so the masking logic stays
 * independent of the prompt-builder internals.
 *
 * @example
 * Input:  "Runtime: agent=main | host=Partha's MacBook Pro | repo=/home/p/.openclaw/workspace | os=Darwin 25.3.0 (arm64) | ..."
 * Output: "Runtime: agent=main | repo=workspace | ..."  (with maskHostname+maskOs+maskRepoPath)
 */
export function applyRuntimeLineMasking(runtimeLine: string, config?: PrivacyConfig): string {
  if (!config?.enabled || !config.systemPrompt) {
    return runtimeLine;
  }

  const sp = config.systemPrompt;
  let line = runtimeLine;

  if (sp.maskHostname) {
    // Strip the host=<value> field (including surrounding " | " separators)
    line = line.replace(/\s*\|\s*host=[^|]*/g, "").replace(/^Runtime:\s*\|\s*/, "Runtime: ");
  }

  if (sp.maskOs) {
    line = line.replace(/\s*\|\s*os=[^|]*/g, "");
  }

  if (sp.maskShell) {
    line = line.replace(/\s*\|\s*shell=[^|]*/g, "");
  }

  if (sp.maskRepoPath) {
    // Replace the full path with just the final directory component
    line = line.replace(/(\|\s*repo=)([^|]+)/g, (_match, prefix, repoPath: string) => {
      const trimmed = repoPath.trimEnd();
      const parts = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
      const basename = parts[parts.length - 1] ?? trimmed;
      return `${prefix}${basename}`;
    });
  }

  // Clean up any double-pipe artefacts produced by removing fields
  line = line
    .replace(/\|\s*\|/g, "|")
    .replace(/\|\s*$/, "")
    .trim();

  return line;
}

// ──────────────────────────────────────────────────────────────────────────────
// Context-file filtering
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Applies PII redaction to the *content* of an embedded context file that
 * would otherwise be injected verbatim into the system prompt.
 *
 * @param filename - The logical filename (e.g. "SOUL.md") — used for logging.
 * @param content  - The raw file contents.
 * @param config   - The privacy config.
 * @returns The (possibly redacted) content string.
 */
export function redactContextFileContent(
  filename: string,
  content: string,
  config?: PrivacyConfig,
): string {
  if (!config?.enabled) {
    return content;
  }

  if (config.systemPrompt?.suppressContextFiles) {
    // Caller should skip injection entirely; return empty to signal suppression.
    return "";
  }

  // pii.enabled defaults to true when privacy.enabled=true (same as redactPii)
  if (config.pii?.enabled !== false && config.pii?.systemPrompt !== false) {
    const { text, stats } = redactPii(content, config);
    if (stats.totalReplacements > 0) {
      // Light logging — avoid leaking the redacted values themselves.
      const summary = Object.entries(stats.byCategory)
        .map(([cat, count]) => `${cat}:${count}`)
        .join(", ");
      process.stderr.write(
        `[privacy] redacted ${stats.totalReplacements} PII item(s) from ${filename} (${summary})\n`,
      );
    }
    return text;
  }

  return content;
}
