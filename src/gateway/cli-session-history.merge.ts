// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  hashCliImageTurnEntryId,
  readCliImageTurnContext,
} from "../agents/cli-image-turn-correlation.js";
import { isOpenClawCliImageCachePath } from "../agents/embedded-agent-runner/run/images.media-refs.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const CLI_ASSISTANT_IDEMPOTENCY_PREFIX = "cli-assistant:";

type ComparableHistoryMessage = {
  message: unknown;
  order: number;
  externalIdentityKey?: string;
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  importedCliAssistantSegment?: boolean;
  role?: string;
  text?: string;
  timestamp?: number;
};

type CliAssistantSegment = ComparableHistoryMessage & { text: string };

type TimestampSummary = {
  hasMissingTimestamp: boolean;
  buckets: Map<number, { min: number; max: number }>;
};

type RoleTextIndex = Map<string, Map<string, TimestampSummary>>;

// Claude records CLI-injected @cache-path suffixes as user text. Keep the
// stored content intact; this normalized view is only for proving a redundant
// imported row against the local turn that owns the durable media facts.
function stripTrailingCliImageMentions(text: string): {
  text: string;
  stripped: boolean;
} {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1]?.trim() ?? "";
    if (!line.startsWith("@") || !isOpenClawCliImageCachePath(line.slice(1))) {
      break;
    }
    end -= 1;
  }
  return end === lines.length
    ? { text, stripped: false }
    : { text: lines.slice(0, end).join("\n").trimEnd(), stripped: true };
}

function isClaudeCliImportedUserMessage(message: unknown, role: string | undefined): boolean {
  if (role !== "user") {
    return false;
  }
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return normalizeOptionalString(meta?.importedFrom) === "claude-cli";
}

function extractComparableText(
  message: unknown,
  role: string | undefined,
): {
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  text?: string;
} {
  if (!message || typeof message !== "object") {
    return { hasCliImageMentions: false };
  }
  const record = message as { role?: unknown; text?: unknown; content?: unknown };
  const parts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    parts.push(text);
  }
  const rawContent = record.content;
  const content = readStringValue(rawContent);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (block && typeof block === "object" && "text" in block) {
        const blockText = readStringValue(block.text);
        if (blockText !== undefined) {
          parts.push(blockText);
        }
      }
    }
  }
  if (parts.length === 0) {
    return { hasCliImageMentions: false };
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return { hasCliImageMentions: false };
  }
  const stripResult = isClaudeCliImportedUserMessage(message, role)
    ? stripTrailingCliImageMentions(joined)
    : { text: joined, stripped: false };
  const visible = stripInlineDirectiveTagsForDisplay(
    role === "user" ? stripInboundMetadata(stripResult.text) : stripResult.text,
  ).text;
  const normalized = visible.replace(/\s+/g, " ").trim();
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const storedImageTurnKey = normalizeOptionalString(meta?.cliImageTurnKey);
  return {
    hasCliImageMentions: stripResult.stripped,
    ...(stripResult.stripped && isClaudeCliImportedUserMessage(message, role)
      ? { cliImageTurnKey: storedImageTurnKey ?? readCliImageTurnContext(joined) }
      : {}),
    ...(normalized ? { text: normalized } : {}),
  };
}

function prepareComparableMessage(
  message: unknown,
  order: number,
  externalIdentityKey: string | undefined,
): ComparableHistoryMessage {
  if (!message || typeof message !== "object") {
    return { message, order, hasCliImageMentions: false };
  }
  const record = message as { role?: unknown; timestamp?: unknown };
  const role = readStringValue(record.role);
  const comparableText = extractComparableText(message, role);
  return {
    message,
    order,
    externalIdentityKey,
    hasCliImageMentions: comparableText.hasCliImageMentions,
    ...(comparableText.cliImageTurnKey ? { cliImageTurnKey: comparableText.cliImageTurnKey } : {}),
    role,
    text: comparableText.text,
    timestamp: asFiniteNumber(record.timestamp),
  };
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
function resolveImportedExternalIdentityKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const rawMeta = (message as { __openclaw?: unknown })["__openclaw"];
  if (!rawMeta || typeof rawMeta !== "object") {
    return undefined;
  }
  const externalId = normalizeOptionalString((rawMeta as { externalId?: unknown }).externalId);
  return externalId
    ? JSON.stringify([
        externalId,
        normalizeOptionalString((rawMeta as { importedFrom?: unknown }).importedFrom),
        normalizeOptionalString((rawMeta as { cliSessionId?: unknown }).cliSessionId),
      ])
    : undefined;
}

function addTimestampToSummary(summary: TimestampSummary, timestamp: number | undefined): void {
  if (timestamp === undefined) {
    summary.hasMissingTimestamp = true;
    return;
  }
  const bucketKey = Math.floor(timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  const bucket = summary.buckets.get(bucketKey);
  if (bucket) {
    bucket.min = Math.min(bucket.min, timestamp);
    bucket.max = Math.max(bucket.max, timestamp);
  } else {
    summary.buckets.set(bucketKey, { min: timestamp, max: timestamp });
  }
}

function summaryHasTimestampMatch(
  summary: TimestampSummary | undefined,
  timestamp: number | undefined,
): boolean {
  if (!summary || timestamp === undefined) {
    return false;
  }
  const bucketKey = Math.floor(timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  if (summary.buckets.has(bucketKey)) {
    return true;
  }
  const previous = summary.buckets.get(bucketKey - 1);
  if (previous && previous.max >= timestamp - DEDUPE_TIMESTAMP_WINDOW_MS) {
    return true;
  }
  const next = summary.buckets.get(bucketKey + 1);
  return next !== undefined && next.min <= timestamp + DEDUPE_TIMESTAMP_WINDOW_MS;
}

function summaryMatchesTimestamp(
  summary: TimestampSummary | undefined,
  timestamp: number | undefined,
): boolean {
  return (
    Boolean(summary && (timestamp === undefined || summary.hasMissingTimestamp)) ||
    summaryHasTimestampMatch(summary, timestamp)
  );
}

function addRoleTextCandidate(index: RoleTextIndex, entry: ComparableHistoryMessage): void {
  if (!entry.role || !entry.text) {
    return;
  }
  let byText = index.get(entry.role);
  if (!byText) {
    byText = new Map();
    index.set(entry.role, byText);
  }
  let summary = byText.get(entry.text);
  if (!summary) {
    summary = { hasMissingTimestamp: false, buckets: new Map() };
    byText.set(entry.text, summary);
  }
  addTimestampToSummary(summary, entry.timestamp);
}

function hasRoleTextCandidate(index: RoleTextIndex, entry: ComparableHistoryMessage): boolean {
  if (!entry.role || !entry.text) {
    return false;
  }
  return summaryMatchesTimestamp(index.get(entry.role)?.get(entry.text), entry.timestamp);
}

function hasLocalImageMediaFacts(entry: ComparableHistoryMessage): boolean {
  if (entry.role !== "user") {
    return false;
  }
  const message = asOptionalRecord(entry.message);
  return message ? (readPersistedMediaFacts(message) ?? []).some(isImageMediaFact) : false;
}

function compareHistoryMessages(a: ComparableHistoryMessage, b: ComparableHistoryMessage): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.order - b.order;
}

function readCliAssistantIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  // SAFETY: guarded as a non-null object above; idempotencyKey stays unknown until normalized.
  const record = message as { idempotencyKey?: unknown };
  const direct = normalizeOptionalString(record.idempotencyKey);
  if (direct?.startsWith(CLI_ASSISTANT_IDEMPOTENCY_PREFIX)) {
    return direct;
  }
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const nested = normalizeOptionalString(meta?.idempotencyKey);
  return nested?.startsWith(CLI_ASSISTANT_IDEMPOTENCY_PREFIX) ? nested : undefined;
}

function hasComparableText(entry: ComparableHistoryMessage): entry is CliAssistantSegment {
  return typeof entry.text === "string" && entry.text.length > 0;
}

function isImportedClaudeCliAssistantSegment(entry: ComparableHistoryMessage): boolean {
  if (entry.role !== "assistant" || !entry.externalIdentityKey || !hasComparableText(entry)) {
    return false;
  }
  const meta = asOptionalRecord(asOptionalRecord(entry.message)?.["__openclaw"]);
  return normalizeOptionalString(meta?.importedFrom) === "claude-cli";
}

// Comparable texts are already whitespace-collapsed, so joining with one space
// matches how the producer's "\n"-joined aggregate normalizes.
function findCoveringSegmentRun(
  aggregateText: string,
  segments: readonly CliAssistantSegment[],
  consumed: Set<CliAssistantSegment>,
): CliAssistantSegment[] | undefined {
  for (let start = 0; start < segments.length; start += 1) {
    let acc = "";
    for (let end = start; end < segments.length; end += 1) {
      const segment = segments[end];
      if (!segment || consumed.has(segment)) {
        break;
      }
      acc = acc ? `${acc} ${segment.text}` : segment.text;
      if (acc === aggregateText) {
        return segments.slice(start, end + 1);
      }
      if (acc.length >= aggregateText.length) {
        break;
      }
    }
  }
  return undefined;
}

// The durable `cli-assistant:<runId>` row and the imported claude-cli segments
// of the same run share nothing but their turn: the CLI transcript never sees
// the runId. So coverage is only proven inside one turn, between the same user
// rows, and each imported segment can stand in for one aggregate at most. Equal
// text from a later turn is a different reply and keeps the earlier one.
function dropCoveredCliAssistantAggregates(
  sorted: ComparableHistoryMessage[],
): ComparableHistoryMessage[] {
  const dropped = new Set<ComparableHistoryMessage>();
  let aggregates: CliAssistantSegment[] = [];
  let segments: CliAssistantSegment[] = [];
  const reconcileTurn = () => {
    const consumed = new Set<CliAssistantSegment>();
    for (const aggregate of aggregates) {
      const run = findCoveringSegmentRun(aggregate.text, segments, consumed);
      if (!run) {
        continue;
      }
      for (const segment of run) {
        consumed.add(segment);
      }
      dropped.add(aggregate);
    }
    aggregates = [];
    segments = [];
  };
  for (const entry of sorted) {
    if (entry.role === "user") {
      reconcileTurn();
    } else if (!hasComparableText(entry)) {
      continue;
    } else if (entry.importedCliAssistantSegment) {
      segments.push(entry);
    } else if (entry.role === "assistant" && readCliAssistantIdempotencyKey(entry.message)) {
      aggregates.push(entry);
    }
  }
  reconcileTurn();
  return dropped.size === 0 ? sorted : sorted.filter((entry) => !dropped.has(entry));
}

/** Merges imported CLI transcript messages into local history without duplicating overlaps. */
export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  const merged = params.localMessages.map((message, order) =>
    prepareComparableMessage(message, order, resolveImportedExternalIdentityKey(message)),
  );
  const exactExternalIdentityIndex = new Set<string>();
  const allMessageRoleTextIndex: RoleTextIndex = new Map();
  const identitylessRoleTextIndex: RoleTextIndex = new Map();
  const localImageMediaCounts = new Map<string, number>();
  const indexEntry = (entry: ComparableHistoryMessage) => {
    if (entry.externalIdentityKey) {
      exactExternalIdentityIndex.add(entry.externalIdentityKey);
    } else {
      addRoleTextCandidate(identitylessRoleTextIndex, entry);
    }
    addRoleTextCandidate(allMessageRoleTextIndex, entry);
  };
  for (const entry of merged) {
    indexEntry(entry);
    if (!hasLocalImageMediaFacts(entry)) {
      continue;
    }
    const localMeta = asOptionalRecord(asOptionalRecord(entry.message)?.["__openclaw"]);
    const localEntryId = normalizeOptionalString(localMeta?.id);
    const turnKey = localEntryId ? hashCliImageTurnEntryId(localEntryId) : entry.cliImageTurnKey;
    if (turnKey) {
      localImageMediaCounts.set(turnKey, (localImageMediaCounts.get(turnKey) ?? 0) + 1);
    }
  }
  let nextOrder = merged.length;
  for (const message of params.importedMessages) {
    const externalIdentityKey = resolveImportedExternalIdentityKey(message);
    if (externalIdentityKey && exactExternalIdentityIndex.has(externalIdentityKey)) {
      continue;
    }
    const imported = prepareComparableMessage(message, nextOrder, externalIdentityKey);
    const turnKey = imported.hasCliImageMentions ? imported.cliImageTurnKey : undefined;
    const matches = turnKey ? localImageMediaCounts.get(turnKey) : undefined;
    if (turnKey && matches) {
      // Each local image turn suppresses one import. Counts preserve repeated
      // keys without retaining or shifting rows that matching never inspects.
      localImageMediaCounts.set(turnKey, matches - 1);
      continue;
    }
    const duplicate = imported.externalIdentityKey
      ? hasRoleTextCandidate(identitylessRoleTextIndex, imported)
      : hasRoleTextCandidate(allMessageRoleTextIndex, imported);
    if (!imported.hasCliImageMentions && duplicate) {
      continue;
    }
    if (isImportedClaudeCliAssistantSegment(imported)) {
      imported.importedCliAssistantSegment = true;
    }
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return dropCoveredCliAssistantAggregates(merged).map((entry) => entry.message);
}
