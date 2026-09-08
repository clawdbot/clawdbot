/** Quality contract, fallback, and audit helpers for compaction safeguard summaries. */
import { localeLowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import type { CompactionSummarizationInstructions } from "../compaction.js";
import { sanitizeDiagnosticPayload } from "../payload-redaction.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";

// Compaction summary quality helpers. They define the structured summary contract
// and audit whether summaries preserve pending asks plus exact identifiers.
const MAX_EXTRACTED_IDENTIFIERS = 12;
const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4000;
const MAX_ASK_OVERLAP_TOKENS = 12;
const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const QUALITY_PROTECTED_SECTION_START = 3;
const PENDING_ASK_SECTION_INDEX = 3;
const EXACT_IDENTIFIERS_SECTION_INDEX = 4;
const MAX_PROTECTED_SECTION_CONTENT_SHARE = 0.25;
const LATEST_USER_REQUEST_CONTEXT_LABEL = "Latest user request context:";
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";

/** Demotes canonical headings when a summary is embedded as supporting context. */
export function nestRequiredSummaryHeadings(text: string): string {
  return text.replace(/^##[ \t]+\S.*$/gmu, (heading) =>
    REQUIRED_SUMMARY_SECTIONS.some((required) => required === heading.trim())
      ? heading.replace("##", "###")
      : heading,
  );
}

/** Wraps operator-provided compaction instruction text as untrusted prompt data. */
export function wrapUntrustedInstructionBlock(label: string, text: string): string {
  return wrapUntrustedPromptDataBlock({
    label,
    text,
    maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS,
  });
}

function resolveExactIdentifierSectionInstruction(
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const policy = summarizationInstructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
  }
  const custom =
    policy === "custom" ? summarizationInstructions?.identifierInstructions?.trim() : undefined;
  if (custom) {
    // Operator text is runtime data, never prompt authority.
    return (
      wrapUntrustedInstructionBlock(
        "For ## Exact identifiers, apply this operator-defined policy text",
        custom,
      ) || STRICT_EXACT_IDENTIFIERS_INSTRUCTION
    );
  }
  return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}

/** Build the required structured summary instructions for compaction. */
export function buildCompactionStructureInstructions(
  customInstructions?: string,
  summarizationInstructions?: CompactionSummarizationInstructions,
  latestUnresolvedUserRequest?: string,
): string {
  const identifierSectionInstruction =
    resolveExactIdentifierSectionInstruction(summarizationInstructions);
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    identifierSectionInstruction,
    "Do not omit unresolved asks from the user.",
    "Record completed requests outside ## Pending user asks; list only unresolved user requests there.",
    "When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail.",
  ].join("\n");
  const latestRequestBlock = latestUnresolvedUserRequest
    ? wrapUntrustedInstructionBlock("Latest unresolved user request", latestUnresolvedUserRequest)
    : "";
  const latestRequestInstruction = latestRequestBlock
    ? [
        "Make the exact request below the first item in ## Pending user asks.",
        "Its run owner will resume it after compaction, so summary prose cannot mark it complete.",
        latestRequestBlock,
      ].join("\n")
    : "";
  const custom = customInstructions?.trim();
  const customBlock =
    custom && wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  return [sectionsTemplate, latestRequestInstruction, customBlock].filter(Boolean).join("\n\n");
}

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) {
      return false;
    }
    cursor = index + 1;
  }
  return true;
}

type SummaryQualityRetentionPlan = {
  minimumChars: number;
  /**
   * True when render() must rebuild even a body that fits: a strict source
   * fact is missing, or an audit-bearing section exceeds its share cap.
   */
  needsRebuild: (maxChars: number) => boolean;
  /** Null when even the protected facts cannot fit `maxChars`. */
  render: (maxChars: number) => { text: string; trimmed: boolean } | null;
};

function parseRequiredSummarySectionContents(summary: string): string[] | null {
  const contents = REQUIRED_SUMMARY_SECTIONS.map(() => new Array<string>());
  const preamble: string[] = [];
  let sectionIndex = -1;

  for (const line of summary.split(/\r?\n/u)) {
    const nextHeading = REQUIRED_SUMMARY_SECTIONS[sectionIndex + 1];
    if (nextHeading && line.trim() === nextHeading) {
      sectionIndex += 1;
      continue;
    }
    (sectionIndex < 0 ? preamble : contents[sectionIndex])?.push(line);
  }
  if (sectionIndex !== REQUIRED_SUMMARY_SECTIONS.length - 1) {
    return null;
  }
  contents[0]?.unshift(...preamble);
  return contents.map((lines) => lines.join("\n").trim());
}

function extractPendingAskSection(summary: string): string {
  const section = summary.split(/^## Pending user asks[ \t]*$/mu, 2)[1];
  return section?.split(/^##[ \t]+\S.*$/mu, 1)[0]?.trim() ?? "";
}

function formatLatestUserRequestContext(request: string): string {
  return `${LATEST_USER_REQUEST_CONTEXT_LABEL} ${JSON.stringify(request)}`;
}

function extractLeadingPendingAsk(summary: string): string {
  return normalizedSummaryLines(extractPendingAskSection(summary))[0] ?? "";
}

function isEmptyPendingAsk(value: string): boolean {
  return /^(?:none|none captured|no pending asks)[.!]?$/iu.test(value);
}

/**
 * Plan truncation that keeps the audit facts and lets everything else shrink.
 * Only the headings, the bounded latest-ask context, and the audited source
 * identifiers are untrimmable. Model-written section text — including the
 * "## Exact identifiers" list — is optional content; protecting it verbatim let
 * a re-distilled identifier dump grow past the whole artifact budget while the
 * real sections were starved to empty headings.
 */
export function createSummaryQualityRetentionPlan(
  summary: string,
  truncatedMarker: string,
  params: {
    auditSummary?: string;
    identifiers: string[];
    latestAsk: string | null;
    latestAskInRetainedTurn?: boolean;
    latestUnresolvedUserRequest?: string;
    requiredAskContext?: string;
    identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
  },
): SummaryQualityRetentionPlan | null {
  const requiredAskContext = params.requiredAskContext?.trim() ?? "";
  const latestUnresolvedUserRequest = params.latestUnresolvedUserRequest?.trim() ?? "";
  const bodyHasLatestAsk = hasAskOverlap(params.auditSummary ?? summary, params.latestAsk);
  const requiredContextBlock =
    !latestUnresolvedUserRequest &&
    (bodyHasLatestAsk || params.latestAskInRetainedTurn) &&
    requiredAskContext
      ? `## Latest user request context\n${JSON.stringify(requiredAskContext)}`
      : "";
  const parsedSummary =
    requiredContextBlock && summary.startsWith(`${requiredContextBlock}\n\n`)
      ? summary.slice(requiredContextBlock.length + 2)
      : summary;
  const contents = parseRequiredSummarySectionContents(parsedSummary);
  if (!contents) {
    return null;
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  const auditedIdentifiers = enforceIdentifiers ? params.identifiers : [];
  const marker = truncatedMarker.trim();
  const pendingAsk = contents[PENDING_ASK_SECTION_INDEX] ?? "";
  const protectedAskContext = latestUnresolvedUserRequest
    ? formatLatestUserRequestContext(latestUnresolvedUserRequest)
    : !params.latestAskInRetainedTurn &&
        requiredAskContext &&
        (!bodyHasLatestAsk ||
          (hasAskOverlap(pendingAsk, params.latestAsk) && !pendingAsk.includes(requiredAskContext)))
      ? `${LATEST_USER_REQUEST_CONTEXT_LABEL}\n${JSON.stringify(requiredAskContext)}`
      : "";
  const protectedTails = REQUIRED_SUMMARY_SECTIONS.map((_, index) =>
    index === PENDING_ASK_SECTION_INDEX
      ? protectedAskContext
      : index === EXACT_IDENTIFIERS_SECTION_INDEX
        ? auditedIdentifiers.join("\n")
        : "",
  );
  const bodyHasIdentifiers = auditedIdentifiers.every((identifier) =>
    summaryIncludesIdentifier(summary, identifier),
  );
  const bodyHasRequiredAskContext = latestUnresolvedUserRequest
    ? extractLeadingPendingAsk(parsedSummary) === protectedAskContext
    : !requiredAskContext
      ? true
      : requiredContextBlock
        ? summary.startsWith(requiredContextBlock)
        : contents[PENDING_ASK_SECTION_INDEX]?.includes(protectedAskContext);
  const renderSections = (sectionContents: string[]) =>
    REQUIRED_SUMMARY_SECTIONS.map((heading, index) => {
      const content = sectionContents[index];
      return content ? `${heading}\n${content}` : heading;
    });
  const joinSectionContent = (index: number, optional: string) => {
    const tail = protectedTails[index] ?? "";
    if (!tail) {
      return optional;
    }
    if (index === PENDING_ASK_SECTION_INDEX) {
      const leading = normalizedSummaryLines(optional)[0] ?? "";
      if (leading === tail) {
        return optional;
      }
      if (latestUnresolvedUserRequest) {
        return [tail, isEmptyPendingAsk(leading) ? "" : optional].filter(Boolean).join("\n");
      }
    }
    if (index === EXACT_IDENTIFIERS_SECTION_INDEX) {
      const missing = auditedIdentifiers.filter(
        (identifier) => !summaryIncludesIdentifier(optional, identifier),
      );
      return [optional, ...missing].filter(Boolean).join("\n");
    }
    const retainedOptional =
      index === PENDING_ASK_SECTION_INDEX && protectedAskContext && isEmptyPendingAsk(optional)
        ? ""
        : optional;
    return [retainedOptional, tail].filter(Boolean).join("\n");
  };
  // Reserve every heading/content/tail separator up front so trimmed optional
  // text can never push the rendered artifact past `maxChars`.
  const minimumBlocks = REQUIRED_SUMMARY_SECTIONS.map(
    (heading, index) => `${heading}\n\n${protectedTails[index] ?? ""}`,
  );
  const minimumSummary = [
    ...(requiredContextBlock ? [requiredContextBlock] : []),
    ...minimumBlocks.slice(0, QUALITY_PROTECTED_SECTION_START),
    marker,
    ...minimumBlocks.slice(QUALITY_PROTECTED_SECTION_START),
  ].join("\n\n");
  // Audit-bearing sections (pending asks, exact identifiers) are funded first so
  // a runaway earlier section cannot starve them, but each is hard-capped: an
  // uncapped identifier list re-distills into the whole budget — even while the
  // artifact still fits — and leaves every other section as a bare heading.
  const protectedCapFor = (maxChars: number) =>
    Math.floor(Math.max(0, maxChars - minimumSummary.length) * MAX_PROTECTED_SECTION_CONTENT_SHARE);
  const protectedWithinCap = (maxChars: number) =>
    contents
      .slice(QUALITY_PROTECTED_SECTION_START)
      .every((content) => content.length <= protectedCapFor(maxChars));

  return {
    minimumChars: minimumSummary.length,
    needsRebuild: (maxChars) =>
      (!latestUnresolvedUserRequest && !bodyHasLatestAsk) ||
      !bodyHasRequiredAskContext ||
      !bodyHasIdentifiers ||
      !protectedWithinCap(maxChars),
    render(maxChars) {
      if (
        summary.length <= maxChars &&
        bodyHasRequiredAskContext &&
        bodyHasIdentifiers &&
        protectedWithinCap(maxChars)
      ) {
        return { text: summary, trimmed: false };
      }
      if (maxChars < minimumSummary.length) {
        return null;
      }
      const contentBudget = maxChars - minimumSummary.length;
      const protectedCap = protectedCapFor(maxChars);
      const allocations = contents.map((content, index) =>
        index >= QUALITY_PROTECTED_SECTION_START ? Math.min(content.length, protectedCap) : 0,
      );
      const optionalBudget = Math.max(
        0,
        contentBudget - allocations.reduce((total, chars) => total + chars, 0),
      );
      const optionalContents = contents.slice(0, QUALITY_PROTECTED_SECTION_START);
      const optionalTotal = optionalContents.reduce((total, content) => total + content.length, 0);
      for (const [index, content] of optionalContents.entries()) {
        allocations[index] =
          optionalTotal > 0 ? Math.floor((optionalBudget * content.length) / optionalTotal) : 0;
      }
      // Surplus returns to the optional sections only; the protected caps stay
      // hard so short decisions cannot hand the budget back to the identifier dump.
      let remainder =
        optionalBudget -
        allocations
          .slice(0, QUALITY_PROTECTED_SECTION_START)
          .reduce((total, chars) => total + chars, 0);
      for (const [index, content] of optionalContents.entries()) {
        const allocation = allocations[index] ?? 0;
        const extra = Math.min(remainder, Math.max(0, content.length - allocation));
        allocations[index] = allocation + extra;
        remainder -= extra;
      }
      const trimmed = contents.some((content, index) => content.length > (allocations[index] ?? 0));
      const sectionContents = contents.map((content, index) =>
        joinSectionContent(index, truncateUtf16Safe(content, allocations[index] ?? 0)),
      );
      const blocks = renderSections(sectionContents);
      return {
        text: [
          ...(requiredContextBlock ? [requiredContextBlock] : []),
          ...blocks.slice(0, QUALITY_PROTECTED_SECTION_START),
          ...(trimmed ? [marker] : []),
          ...blocks.slice(QUALITY_PROTECTED_SECTION_START),
        ].join("\n\n"),
        trimmed,
      };
    },
  };
}

/** Return a structured fallback summary when model output is missing/invalid. */
export function buildStructuredFallbackSummary(previousSummary: string | undefined): string {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) {
    return trimmedPreviousSummary;
  }
  const values = [
    trimmedPreviousSummary || "No prior history.",
    "None.",
    "None.",
    "None.",
    "None captured.",
  ];
  return REQUIRED_SUMMARY_SECTIONS.map((heading, index) => `${heading}\n${values[index]}`).join(
    "\n\n",
  );
}

/** Appends a bounded post-compaction section to an existing summary. */
export function appendSummarySection(summary: string, section: string): string {
  if (!section) {
    return summary;
  }
  if (!summary.trim()) {
    return section.trimStart();
  }
  return `${summary}${section}`;
}

function sanitizeExtractedIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)\]"'`,;:.!?<>]+$/, "");
}

// Blocklist for credential-shaped prefixes. These strings are common API key,
// token, and secret prefixes that should never be re-appended to a compaction
// summary. Case-insensitive check against the start of the sanitized value.
const CREDENTIAL_PREFIXES = [
  "sk-",
  "pk-",
  "rk-",
  "sk_live_",
  "sk_test_",
  "pk_live_",
  "pk_test_",
  "whsec_",
  "xoxb-",
  "xoxp-",
  "xoxs-",
  "xoxa-",
  "ghp_",
  "gho_",
  "ghs_",
  "ghu_",
  "github_pat_",
  "glpat-",
  "glcbt-",
  "Bearer ",
  "bearer ",
  "AKIA",
  "ASIA",
  "eyJ", // JWT prefix (base64-encoded '{')
];

// URL query parameter names that commonly carry secrets.
const CREDENTIAL_URL_PARAMS =
  /[?&](token|access_token|api_key|apikey|secret|password|auth|key|credential)=/i;

function isCredentialShaped(value: string): boolean {
  const lower = value.toLowerCase();
  for (const prefix of CREDENTIAL_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return true;
    }
  }
  if (value.startsWith("http") && CREDENTIAL_URL_PARAMS.test(value)) {
    return true;
  }
  return false;
}

// Pre-extraction redaction: remove credential-shaped substrings from input text
// BEFORE the identifier regex runs. This prevents hex fragments of API keys
// (e.g. "abcd1234ef" from "sk-abcd1234efgh") from surviving as identifiers
// when the prefix falls outside the regex match boundary.
const CREDENTIAL_REDACT_PATTERN = new RegExp(
  "(?:" +
    CREDENTIAL_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")[A-Za-z0-9_\\-.+/=]{4,}",
  "gi",
);

function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_REDACT_PATTERN, "");
}

// Name/value credential shapes in non-JSON tool argument strings
// (e.g. "token: deadbeef12345678") that lack a known secret prefix.
const CREDENTIAL_NAME_VALUE_PATTERN =
  /\b(?:token|api[_-]?key|password|secret|auth|credential|access[_-]?token)\s*[:=]\s*[A-Za-z0-9_+\-./=]{8,}/gi;

function redactUnsafeRawToolArgument(text: string): string {
  return redactCredentials(text.replace(CREDENTIAL_NAME_VALUE_PATTERN, ""));
}

function isPureHexIdentifier(value: string): boolean {
  return /^[A-Fa-f0-9]{8,}$/.test(value);
}

function normalizeOpaqueIdentifier(value: string): string {
  return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (isPureHexIdentifier(identifier)) {
    return summary.toUpperCase().includes(identifier.toUpperCase());
  }
  return summary.includes(identifier);
}

/** Extracts likely exact identifiers that summaries should preserve literally. */
export function extractOpaqueIdentifiers(text: string): string[] {
  // Decimal/scientific syntax is unambiguous numeric data, including unit suffixes. Integer tokens
  // with letters remain opaque because the suffix may be part of an exact identifier.
  // Redact credentials first so secret-shaped tokens are not promoted into required
  // identifiers.
  const safeText = redactCredentials(text);
  return uniqueStrings(
    Array.from(
      safeText.matchAll(
        /(https?:\/\/\S+|(?<![A-Za-z0-9._-])\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5})|(?:(?:(?:\d+\.\d+|\.\d+)(?:[eE][+-]?\d+)?|\d+\.[eE][+-]?\d+|\d+\.?[eE][+-]\d+|(?![A-Fa-f0-9]{8,}(?![A-Fa-f0-9]))\d+\.?[eE]\d+)(?:(?=[A-Za-z]+(?![A-Za-z0-9]))(?=[A-Za-z]*[G-Zg-z])[A-Za-z]+)?(?![A-Za-z0-9])|(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*(?:[A-Fa-f0-9]{8,}|\d{6,}))([A-Za-z0-9_-]+))/g,
      ),
      (match) => match[1] ?? match[2] ?? "",
    )
      .map((value) => sanitizeExtractedIdentifier(value))
      .filter((value) => !isCredentialShaped(value))
      .map((value) => normalizeOpaqueIdentifier(value))
      .filter((value) => value.length >= 4),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

const TOOL_CALL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "functionCall",
  "function_call",
]);

export function extractMessageTextForIdentifiers(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const parts: string[] = [];
  // SAFETY: caller already rejected non-objects; content is read optionally.
  const msg = message as { content?: unknown };
  const content = msg.content;
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      // SAFETY: block is a non-null object; we only read known optional keys.
      const rec = block as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        parts.push(rec.text);
      }
      if (typeof rec.type === "string" && TOOL_CALL_BLOCK_TYPES.has(rec.type)) {
        const args = rec.arguments ?? rec.input;
        if (typeof args === "string") {
          // String-encoded arguments (e.g. OpenAI's JSON-stringified format)
          // may contain credential fields. Parse and sanitize before extraction
          // to avoid leaking secrets into the ## Exact identifiers section.
          try {
            const parsed: unknown = JSON.parse(args);
            if (parsed && typeof parsed === "object") {
              parts.push(JSON.stringify(sanitizeDiagnosticPayload(parsed)));
            } else {
              parts.push(args);
            }
          } catch {
            // Not valid JSON; redact name/value credential shapes and known
            // prefixes before identifier extraction so hex-looking secrets
            // do not land in ## Exact identifiers.
            const redacted = redactUnsafeRawToolArgument(args);
            if (redacted.trim()) {
              parts.push(redacted);
            }
          }
        } else if (args && typeof args === "object") {
          try {
            // Redact credential-shaped fields (apiKey, token, password, secret)
            // before identifier extraction to avoid leaking secrets into
            // compaction summaries.
            parts.push(JSON.stringify(sanitizeDiagnosticPayload(args)));
          } catch {
            // skip unserializable args
          }
        }
      }
    }
  }
  return parts.join("\n");
}

// Scan budget: cap total extracted text to avoid unbounded synchronous work on
// large transcripts with big tool arguments/results.
const MAX_EXTRACTION_CHARS = 500_000;

export function extractIdentifiersFromMessages(messages: unknown[]): string[] {
  const parts: string[] = [];
  let totalChars = 0;
  for (const msg of messages) {
    const text = extractMessageTextForIdentifiers(msg);
    if (!text) {
      continue;
    }
    if (totalChars + text.length > MAX_EXTRACTION_CHARS) {
      const remaining = MAX_EXTRACTION_CHARS - totalChars;
      if (remaining > 0) {
        parts.push(text.slice(0, remaining));
      }
      break;
    }
    parts.push(text);
    totalChars += text.length;
  }
  return extractOpaqueIdentifiers(parts.join("\n"));
}

export function computeLostIdentifiers(sourceIdentifiers: string[], summary: string): string[] {
  return sourceIdentifiers.filter((identifier) => !summaryIncludesIdentifier(summary, identifier));
}

function tokenizeAskOverlapText(text: string): string[] {
  const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC")).trim();
  if (!normalized) {
    return [];
  }
  const keywords = extractKeywords(normalized);
  if (keywords.length > 0) {
    return keywords;
  }
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function resolveAskOverlapRequirement(latestAsk: string | null): {
  tokens: string[];
  requiredMatches: number;
} | null {
  if (!latestAsk) {
    return null;
  }
  const askTokens = uniqueStrings(tokenizeAskOverlapText(latestAsk)).slice(
    0,
    MAX_ASK_OVERLAP_TOKENS,
  );
  if (askTokens.length === 0) {
    return null;
  }
  const meaningfulAskTokens = askTokens.filter(
    (token) => token.length > 1 && !isQueryStopWordToken(token),
  );
  const tokensToCheck = meaningfulAskTokens.length > 0 ? meaningfulAskTokens : askTokens;
  const requiredMatches = tokensToCheck.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
  return { tokens: tokensToCheck, requiredMatches };
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  const requirement = resolveAskOverlapRequirement(latestAsk);
  if (!requirement) {
    return true;
  }
  const summaryTokens = new Set(tokenizeAskOverlapText(summary));
  const overlapCount = requirement.tokens.filter((token) => summaryTokens.has(token)).length;
  return overlapCount >= requirement.requiredMatches;
}

/** Audits a candidate summary for required sections, pending asks, and identifier preservation. */
export function auditSummaryQuality(params: {
  summary: string;
  structuralSummary: string;
  sourceSummaries?: string[];
  identifiers: string[];
  latestAsk: string | null;
  latestUnresolvedUserRequest?: string;
  retainedTurnSummary?: string;
  identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.structuralSummary));
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
    }
    if (
      params.sourceSummaries?.some(
        (source) => normalizedSummaryLines(source).filter((line) => line === section).length > 1,
      )
    ) {
      reasons.push(`duplicate_section:${section}`);
    }
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  if (enforceIdentifiers) {
    const missingIdentifiers = params.identifiers.filter(
      (identifier) => !summaryIncludesIdentifier(params.summary, identifier),
    );
    if (missingIdentifiers.length > 0) {
      reasons.push(`missing_identifiers:${missingIdentifiers.slice(0, 3).join(",")}`);
    }
  }
  const leadingPendingAsk = extractLeadingPendingAsk(params.structuralSummary);
  if (
    params.latestUnresolvedUserRequest &&
    leadingPendingAsk !== formatLatestUserRequestContext(params.latestUnresolvedUserRequest)
  ) {
    reasons.push("latest_user_ask_not_foregrounded");
  } else if (
    !params.latestUnresolvedUserRequest &&
    !hasAskOverlap(params.summary, params.latestAsk)
  ) {
    reasons.push("latest_user_ask_not_reflected");
  }
  const retainedPendingAsk = extractLeadingPendingAsk(params.retainedTurnSummary ?? "");
  if (
    params.latestUnresolvedUserRequest
      ? retainedPendingAsk && !isEmptyPendingAsk(retainedPendingAsk)
      : params.retainedTurnSummary !== undefined &&
        resolveAskOverlapRequirement(params.latestAsk) &&
        hasAskOverlap(extractPendingAskSection(params.retainedTurnSummary), params.latestAsk)
  ) {
    reasons.push("retained_turn_ask_marked_pending");
  }
  return { ok: reasons.length === 0, reasons };
}
