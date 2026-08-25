/** Quality contract, fallback, and audit helpers for compaction safeguard summaries. */
import { localeLowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import type { CompactionSummarizationInstructions } from "../compaction.js";
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
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";

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
): string {
  const identifierSectionInstruction =
    resolveExactIdentifierSectionInstruction(summarizationInstructions);
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    identifierSectionInstruction,
    "Do not omit unresolved asks from the user.",
    "When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail.",
  ].join("\n");
  const custom = customInstructions?.trim();
  const customBlock =
    custom && wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  return customBlock ? `${sectionsTemplate}\n\n${customBlock}` : sectionsTemplate;
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
  render: (maxChars: number) => string | null;
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

/** Plan truncation that keeps audit-required headings, pending asks, and exact identifiers. */
export function createSummaryQualityRetentionPlan(
  summary: string,
  truncatedMarker: string,
  params: {
    auditSummary?: string;
    identifiers: string[];
    latestAsk: string | null;
    requiredAskContext?: string;
    identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
  },
): SummaryQualityRetentionPlan | null {
  const contents = parseRequiredSummarySectionContents(summary);
  if (!contents) {
    return null;
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  const auditSummary = params.auditSummary ?? summary;
  if (
    enforceIdentifiers &&
    params.identifiers.some((identifier) => !summaryIncludesIdentifier(auditSummary, identifier))
  ) {
    return null;
  }
  if (!hasAskOverlap(auditSummary, params.latestAsk)) {
    return null;
  }
  const pendingAsk = contents[QUALITY_PROTECTED_SECTION_START] ?? "";
  const requiredAskContext = params.requiredAskContext?.trim() ?? "";
  const exactIdentifiers = contents[QUALITY_PROTECTED_SECTION_START + 1] ?? "";
  const missingIdentifiers = enforceIdentifiers
    ? params.identifiers.filter(
        (identifier) => !summaryIncludesIdentifier(exactIdentifiers, identifier),
      )
    : [];
  const protectedContents = [
    [
      pendingAsk,
      requiredAskContext && !pendingAsk.includes(requiredAskContext) ? requiredAskContext : "",
    ]
      .filter(Boolean)
      .join("\n"),
    [exactIdentifiers, ...missingIdentifiers].filter(Boolean).join("\n"),
  ];
  const marker = truncatedMarker.trim();
  const protectedBlocks = REQUIRED_SUMMARY_SECTIONS.slice(QUALITY_PROTECTED_SECTION_START).map(
    (heading, index) => {
      const content = protectedContents[index];
      return content ? `${heading}\n${content}` : heading;
    },
  );
  const optionalHeadings = REQUIRED_SUMMARY_SECTIONS.slice(0, QUALITY_PROTECTED_SECTION_START);
  const optionalContents = contents.slice(0, QUALITY_PROTECTED_SECTION_START);
  const optionalScaffolds = optionalHeadings.map((heading, index) =>
    optionalContents[index] ? `${heading}\n` : heading,
  );
  const minimumSummary = [...optionalScaffolds, marker, ...protectedBlocks].join("\n\n");

  return {
    minimumChars: minimumSummary.length,
    render(maxChars) {
      const bodyHasRequiredAskContext = !requiredAskContext || summary.includes(requiredAskContext);
      const bodyHasIdentifiers =
        !enforceIdentifiers ||
        params.identifiers.every((identifier) => summaryIncludesIdentifier(summary, identifier));
      if (summary.length <= maxChars && bodyHasRequiredAskContext && bodyHasIdentifiers) {
        return summary;
      }
      if (maxChars < minimumSummary.length) {
        return null;
      }
      const contentBudget = maxChars - minimumSummary.length;
      const totalContentChars = optionalContents.reduce(
        (total, content) => total + content.length,
        0,
      );
      const allocations = optionalContents.map((content) =>
        totalContentChars > 0
          ? Math.floor((contentBudget * content.length) / totalContentChars)
          : 0,
      );
      let remainder = contentBudget - allocations.reduce((total, chars) => total + chars, 0);
      for (const [index, content] of optionalContents.entries()) {
        const allocation = allocations[index] ?? 0;
        const extra = Math.min(remainder, Math.max(0, content.length - allocation));
        allocations[index] = allocation + extra;
        remainder -= extra;
      }
      const optionalBlocks = optionalHeadings.map((heading, index) => {
        const content = truncateUtf16Safe(optionalContents[index] ?? "", allocations[index] ?? 0);
        return content ? `${heading}\n${content}` : heading;
      });
      return [...optionalBlocks, marker, ...protectedBlocks].join("\n\n");
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
  // Path and host/port candidates start at token boundaries so prose such as
  // "typecheck/lint/format" is not mistaken for an absolute path.
  const matches =
    text.match(
      /([A-Fa-f0-9]{8,}|https?:\/\/\S+|(?<![A-Za-z0-9._-])\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g,
    ) ?? [];
  return uniqueStrings(
    matches
      .map((value) => normalizeOpaqueIdentifier(sanitizeExtractedIdentifier(value)))
      .filter((value) => value.length >= 4),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
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
  const { requiredMatches } = requirement;
  return overlapCount >= requiredMatches;
}

/** Audits a candidate summary for required sections, pending asks, and identifier preservation. */
export function auditSummaryQuality(params: {
  summary: string;
  structuralSummary: string;
  identifiers: string[];
  latestAsk: string | null;
  identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.structuralSummary));
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
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
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }
  return { ok: reasons.length === 0, reasons };
}
