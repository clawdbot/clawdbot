import {
  asOptionalRecord as asRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { extractTextContentParts } from "./query.js";
import {
  ACTIVE_MEMORY_PLUGIN_TAG,
  ACTIVE_MEMORY_CONTEXT_HEADER,
  NO_RECALL_VALUES,
  STRUCTURED_MEMORY_EMPTY_STATUSES,
  STRUCTURED_MEMORY_FAILURE_STATUSES,
  TIMEOUT_BOILERPLATE_PATTERNS,
  type ActiveMemoryPromptStyle,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

function buildPromptStyleLines(style: ActiveMemoryPromptStyle): string[] {
  switch (style) {
    case "strict":
      return [
        "Treat the latest user message as the only primary query.",
        "Use any additional context only for narrow disambiguation.",
        "Do not return memory just because it matches the broader conversation topic.",
        "Return memory only if it clearly helps with the latest user message itself.",
        "If the latest user message does not strongly call for memory, reply with NONE.",
        "If the connection is weak, indirect, or speculative, reply with NONE.",
      ];
    case "contextual":
      return [
        "Treat the latest user message as the primary query.",
        "Use recent conversation to understand continuity and intent, but do not let older context override the latest user message.",
        "When the latest message shifts domains, prefer memory that matches the new domain.",
        "Return memory when it materially helps the other model answer the latest user message or maintain clear conversational continuity.",
      ];
    case "recall-heavy":
      return [
        "Treat the latest user message as the primary query, but be willing to surface memory on softer plausible matches when it would add useful continuity or personalization.",
        "If there is a credible recurring preference, habit, or user-context match, lean toward returning memory instead of NONE.",
        "Still prefer the memory domain that best matches the latest user message.",
      ];
    case "precision-heavy":
      return [
        "Treat the latest user message as the primary query.",
        "Use recent conversation only for narrow disambiguation.",
        "Aggressively prefer NONE unless the memory clearly and directly helps with the latest user message.",
        "Do not return memory for soft, speculative, or loosely adjacent matches.",
      ];
    case "preference-only":
      return [
        "Treat the latest user message as the primary query.",
        "Optimize for favorites, preferences, habits, routines, taste, and recurring personal facts.",
        "If relevant memory is mostly a stable user preference or recurring habit, lean toward returning it.",
        "If the strongest match is only a one-off historical fact and not a recurring preference or habit, prefer NONE unless the latest user message clearly asks for that fact.",
      ];
    default:
      return [
        "Treat the latest user message as the primary query.",
        "Use recent conversation only to disambiguate what the latest user message means.",
        "Do not return memory just because it matched the broader recent topic; return memory only if it clearly helps with the latest user message itself.",
        "If recent context and the latest user message point to different memory domains, prefer the domain that best matches the latest user message.",
      ];
  }
}

function buildRecallPrompt(params: {
  config: ResolvedActiveRecallPluginConfig;
  query: string;
  searchQuery: string;
}): string {
  const defaultInstructions = [
    "You are a memory search agent.",
    "Another model is preparing the final user-facing answer.",
    "Your job is to search memory and return only the most relevant memory context for that model.",
    "You receive a bounded search query plus conversation context, including the user's latest message.",
    "Use only the available memory tools.",
    "Use the bounded search query with the configured memory tools.",
    `Configured memory tools: ${params.config.toolsAllow.join(", ")}.`,
    "Do not use channel metadata, provider metadata, debug output, or the full conversation context as the memory tool query.",
    "If the available memory tools find nothing useful, reply with NONE.",
    "When searching for preference or habit recall, use permissive search limits or thresholds before deciding that no useful memory exists.",
    "Do not answer the user directly.",
    `Prompt style: ${params.config.promptStyle}.`,
    ...buildPromptStyleLines(params.config.promptStyle),
    "If the user is directly asking about favorites, preferences, habits, routines, or personal facts, treat that as a strong recall signal.",
    "Questions like 'what is my favorite food', 'do you remember my flight preferences', or 'what do i usually get' should normally return memory when relevant results exist.",
    "If the provided conversation context already contains recalled-memory summaries, debug output, or prior memory/tool traces, ignore that surfaced text unless the latest user message clearly requires re-checking it.",
    "Return memory only when it would materially help the other model answer the user's latest message.",
    "Mutable operational facts (cron/job health, automation status, deployments, incidents, service availability) go stale quickly: include the source timestamp when available, say when the memory may be stale, and tell the answering model to verify live before relying on it.",
    "Do not summarize mutable operational facts as simply current/running/healthy unless the memory result itself contains a current source timestamp and matching health state.",
    "If the connection is weak, broad, or only vaguely related, reply with NONE.",
    "If nothing clearly useful is found, reply with NONE.",
    "Return exactly one of these two forms:",
    "1. NONE",
    "2. one compact plain-text summary",
    `If something is useful, reply with one compact plain-text summary under ${params.config.maxSummaryChars} characters total.`,
    "Write the summary as a memory note about the user, not as a reply to the user.",
    "Do not explain your reasoning.",
    "Do not return bullets, numbering, labels, XML, JSON, or markdown list formatting.",
    "Do not prefix the summary with 'Memory:' or any other label.",
    "",
    "Good examples:",
    "User message: What is my favorite food?",
    "Return: User's favorite food is ramen; tacos also come up often.",
    "User message: Do you remember my flight preferences?",
    "Return: User prefers aisle seats and extra buffer over tight connections.",
    "Recent context: user was discussing flights and airport planning.",
    "Latest user message: I might see a movie while I wait for the flight.",
    "Return: User's favorite movie snack is buttery popcorn with extra salt.",
    "User message: Explain DNS over HTTPS.",
    "Return: NONE",
    "",
    "Bad examples:",
    "Return: - Favorite food is ramen",
    "Return: 1. Favorite food is ramen",
    "Return: Memory: Favorite food is ramen",
    'Return: {"memory":"Favorite food is ramen"}',
    "Return: <memory>Favorite food is ramen</memory>",
    "Return: Ramen seems to be your favorite food.",
    "Return: You like aisle seats and extra buffer.",
    "Return: I prefer aisle seats and extra buffer.",
    "Recent context: user was discussing flights and airport planning. Latest user message: I might see a movie while I wait for the flight. Return: User prefers aisle seats and extra buffer over tight connections.",
  ].join("\n");
  const instructionBlock = [
    params.config.promptOverride ?? defaultInstructions,
    params.config.promptAppend
      ? `Additional operator instructions:\n${params.config.promptAppend}`
      : "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
  return [
    instructionBlock,
    `Bounded memory search query:\n${params.searchQuery}`,
    `Conversation context:\n${params.query}`,
  ].join("\n\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeNoRecallValue(value: string): boolean {
  return NO_RECALL_VALUES.has(value.trim().toLowerCase());
}

function readExplicitMemoryEvidence(source: Record<string, unknown>): boolean | undefined {
  const status = normalizeOptionalString(source.status)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (status !== undefined && STRUCTURED_MEMORY_EMPTY_STATUSES.has(status)) {
    return false;
  }
  const resultCollections = [source.results, source.memories, source.items];
  if (resultCollections.some((entry) => Array.isArray(entry))) {
    return resultCollections.some((entry) => Array.isArray(entry) && entry.length > 0);
  }
  const resultCounts = [
    source.count,
    source.matches,
    source.memoryCount,
    source.resultCount,
    source.totalMatches,
  ];
  if (resultCounts.some((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    return resultCounts.some(
      (entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0,
    );
  }
  if (typeof source.found === "boolean" || typeof source.hasResults === "boolean") {
    return source.found === true || source.hasResults === true;
  }
  return undefined;
}

function readStructuredMemoryFailure(source: unknown): boolean | undefined {
  const record = asRecord(source);
  if (!record) {
    return undefined;
  }
  const status = normalizeOptionalString(record.status)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  const hasFailureStatus = status !== undefined && STRUCTURED_MEMORY_FAILURE_STATUSES.has(status);
  const hasFailureFields =
    hasFailureStatus ||
    ["disabled", "unavailable", "success", "error"].some((key) => key in record);
  if (!hasFailureFields) {
    return undefined;
  }
  return (
    hasFailureStatus ||
    record.disabled === true ||
    record.unavailable === true ||
    record.success === false ||
    Boolean(record.error)
  );
}

function readStructuredMemoryEvidence(source: unknown): boolean | undefined {
  if (Array.isArray(source)) {
    return source.length > 0;
  }
  const record = asRecord(source);
  return record ? readExplicitMemoryEvidence(record) : undefined;
}

function readStructuredContentState(
  content: unknown,
  readState: (source: unknown) => boolean | undefined,
  decisiveState: boolean,
): boolean | undefined {
  const parts = extractTextContentParts(content);
  let sawOtherState = false;
  for (const part of parts) {
    try {
      const state = readState(JSON.parse(part));
      if (state === decisiveState) {
        return decisiveState;
      }
      sawOtherState ||= state === !decisiveState;
    } catch {}
  }
  try {
    const state = readState(JSON.parse(parts.join(" ").trim()));
    if (state !== undefined) {
      return state;
    }
  } catch {}
  return sawOtherState ? !decisiveState : undefined;
}

function readStructuredMemoryFailureFromContent(content: unknown): boolean | undefined {
  return readStructuredContentState(content, readStructuredMemoryFailure, true);
}

function readStructuredMemoryEvidenceFromContent(content: unknown): boolean | undefined {
  return readStructuredContentState(content, readStructuredMemoryEvidence, false);
}

function isTimeoutBoilerplateSummary(value: string): boolean {
  return TIMEOUT_BOILERPLATE_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeActiveSummary(rawReply: string): string | null {
  const trimmed = rawReply.trim();
  if (normalizeNoRecallValue(trimmed)) {
    return null;
  }
  const singleLine = trimmed.replace(/\s+/g, " ").trim();
  if (
    !singleLine ||
    normalizeNoRecallValue(singleLine) ||
    isTimeoutBoilerplateSummary(singleLine)
  ) {
    return null;
  }
  return singleLine;
}

function truncateSummary(summary: string, maxSummaryChars: number): string {
  const trimmed = summary.trim();
  if (trimmed.length <= maxSummaryChars) {
    return trimmed;
  }

  const ellipsis = "…";
  if (maxSummaryChars <= ellipsis.length) {
    return ellipsis.slice(0, Math.max(0, maxSummaryChars));
  }
  const contentMaxChars = maxSummaryChars - ellipsis.length;
  const rawBounded = trimmed.slice(0, contentMaxChars).trimEnd();
  const bounded = truncateUtf16Safe(trimmed, contentMaxChars).trimEnd();
  const nextChar = trimmed.charAt(contentMaxChars);
  if (!nextChar || /\s/.test(nextChar)) {
    return `${bounded}${ellipsis}`;
  }

  const lastBoundary = rawBounded.search(/\s\S*$/);
  if (lastBoundary > 0) {
    return `${truncateUtf16Safe(trimmed, lastBoundary).trimEnd()}${ellipsis}`;
  }

  return `${bounded}${ellipsis}`;
}

function buildMetadata(summary: string | null): string | undefined {
  if (!summary) {
    return undefined;
  }
  return [
    `<${ACTIVE_MEMORY_PLUGIN_TAG}>`,
    escapeXml(summary),
    `</${ACTIVE_MEMORY_PLUGIN_TAG}>`,
  ].join("\n");
}

function buildPromptPrefix(summary: string | null): string | undefined {
  const metadata = buildMetadata(summary);
  if (!metadata) {
    return undefined;
  }
  return [ACTIVE_MEMORY_CONTEXT_HEADER, metadata].join("\n");
}

export {
  buildMetadata,
  buildPromptPrefix,
  buildRecallPrompt,
  normalizeActiveSummary,
  readExplicitMemoryEvidence,
  readStructuredMemoryEvidenceFromContent,
  readStructuredMemoryFailure,
  readStructuredMemoryFailureFromContent,
  truncateSummary,
};
