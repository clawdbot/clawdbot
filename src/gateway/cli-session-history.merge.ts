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
  // Local user row (by order) that anchors this row's turn; undefined when unknown.
  turn?: number;
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

function isClaudeCliImportedMessage(message: unknown): boolean {
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  return normalizeOptionalString(meta?.importedFrom) === "claude-cli";
}

function isClaudeCliImportedUserMessage(message: unknown, role: string | undefined): boolean {
  return role === "user" && isClaudeCliImportedMessage(message);
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

// The durable reply keeps its key on the row; older transcript metadata nests it.
function isCliAssistantAggregate(entry: ComparableHistoryMessage): boolean {
  const record = asOptionalRecord(entry.message);
  const key =
    normalizeOptionalString(record?.idempotencyKey) ??
    normalizeOptionalString(asOptionalRecord(record?.["__openclaw"])?.idempotencyKey);
  return entry.role === "assistant" && key?.startsWith(CLI_ASSISTANT_IDEMPOTENCY_PREFIX) === true;
}

function hasComparableText(entry: ComparableHistoryMessage): entry is CliAssistantSegment {
  return typeof entry.text === "string" && entry.text.length > 0;
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

// The durable `cli-assistant:<runId>` row and its imported segments share
// nothing but their turn (the CLI transcript never sees the runId), and turn
// membership comes from each source's own order, never from timestamps.
// Each segment stands in for one aggregate at most.
function dropCoveredCliAssistantAggregates(
  entries: ComparableHistoryMessage[],
): ComparableHistoryMessage[] {
  const segmentsByTurn = new Map<number, CliAssistantSegment[]>();
  const aggregates: Array<[number, CliAssistantSegment]> = [];
  for (const entry of entries) {
    if (entry.turn === undefined || !hasComparableText(entry)) {
      continue;
    }
    if (entry.importedCliAssistantSegment) {
      segmentsByTurn.set(entry.turn, [...(segmentsByTurn.get(entry.turn) ?? []), entry]);
    } else if (isCliAssistantAggregate(entry)) {
      aggregates.push([entry.turn, entry]);
    }
  }
  const dropped = new Set<ComparableHistoryMessage>();
  const consumed = new Set<CliAssistantSegment>();
  for (const [turn, aggregate] of aggregates) {
    const run = findCoveringSegmentRun(aggregate.text, segmentsByTurn.get(turn) ?? [], consumed);
    if (run) {
      run.forEach((segment) => consumed.add(segment));
      dropped.add(aggregate);
    }
  }
  return dropped.size === 0 ? entries : entries.filter((entry) => !dropped.has(entry));
}

type LocalTurnBucket = {
  turns: Array<{ order: number; timestamp: number | undefined }>;
  cursor: number;
};

// Picks the local turn an imported user row duplicates. A timestamp inside the
// dedupe window names one turn outright. Without that evidence the only safe
// alignment is a single remaining candidate: guessing between repeats of the
// same prompt can attach an import to the wrong turn, and reconciliation would
// then drop the aggregate that answered the other one. Ambiguity yields
// undefined, which leaves every aggregate in that turn alone.
function takeAlignedLocalTurn(
  bucket: LocalTurnBucket,
  timestamp: number | undefined,
): number | undefined {
  if (timestamp !== undefined) {
    for (let i = bucket.cursor; i < bucket.turns.length; i += 1) {
      const candidate = bucket.turns[i];
      if (candidate?.timestamp === undefined) {
        continue;
      }
      if (Math.abs(candidate.timestamp - timestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS) {
        bucket.cursor = i + 1;
        return candidate.order;
      }
    }
  }
  if (bucket.turns.length - bucket.cursor !== 1) {
    return undefined;
  }
  const only = bucket.turns[bucket.cursor];
  bucket.cursor += 1;
  return only?.order;
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
  // Buckets of local user turns per prompt text, appended in order, each with a
  // cursor so matching an import walks forward instead of rescanning the bucket.
  const localTurnsByUserText = new Map<string, LocalTurnBucket>();
  let localTurn: number | undefined;
  for (const entry of merged) {
    indexEntry(entry);
    if (entry.role === "user") {
      localTurn = entry.order;
      if (entry.text) {
        const bucket = localTurnsByUserText.get(entry.text);
        if (bucket) {
          bucket.turns.push({ order: entry.order, timestamp: entry.timestamp });
        } else {
          localTurnsByUserText.set(entry.text, {
            turns: [{ order: entry.order, timestamp: entry.timestamp }],
            cursor: 0,
          });
        }
      }
    }
    entry.turn = localTurn;
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
  // A dropped imported user row joins the local turn it duplicates; a kept one
  // starts a turn with no local aggregate to cover.
  let importedTurn: number | undefined;
  const isDuplicateImport = (imported: ComparableHistoryMessage): boolean => {
    if (exactExternalIdentityIndex.has(imported.externalIdentityKey ?? "")) {
      return true;
    }
    const turnKey = imported.hasCliImageMentions ? imported.cliImageTurnKey : undefined;
    const matches = turnKey ? localImageMediaCounts.get(turnKey) : undefined;
    if (turnKey && matches) {
      // Each local image turn suppresses one import. Counts preserve repeated
      // keys without retaining or shifting rows that matching never inspects.
      localImageMediaCounts.set(turnKey, matches - 1);
      return true;
    }
    const duplicate = imported.externalIdentityKey
      ? hasRoleTextCandidate(identitylessRoleTextIndex, imported)
      : hasRoleTextCandidate(allMessageRoleTextIndex, imported);
    return !imported.hasCliImageMentions && duplicate;
  };
  for (const message of params.importedMessages) {
    const imported = prepareComparableMessage(
      message,
      nextOrder,
      resolveImportedExternalIdentityKey(message),
    );
    const duplicate = isDuplicateImport(imported);
    if (imported.role === "user") {
      const bucket =
        duplicate && imported.text ? localTurnsByUserText.get(imported.text) : undefined;
      importedTurn = bucket ? takeAlignedLocalTurn(bucket, imported.timestamp) : undefined;
    } else if (imported.role === "assistant" && isClaudeCliImportedMessage(imported.message)) {
      // Provenance is the importedFrom stamp; uuid-less records have no externalId.
      imported.importedCliAssistantSegment = true;
      imported.turn = importedTurn;
    }
    if (duplicate) {
      continue;
    }
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
  }
  const uncovered = dropCoveredCliAssistantAggregates(merged);
  uncovered.sort(compareHistoryMessages);
  return uncovered.map((entry) => entry.message);
}
