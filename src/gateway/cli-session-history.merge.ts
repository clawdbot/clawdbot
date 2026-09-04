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

type ComparableHistoryMessage = {
  message: unknown;
  order: number;
  externalIdentityKey?: string;
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  role?: string;
  text?: string;
  timestamp?: number;
  // CLI turn facts, derived from the same single read of each raw field, so
  // turn-level suppression adds no second pass over the messages.
  isCliAggregate?: boolean;
  isToolResultOnly?: boolean;
  // The native turn a persisted aggregate flattens, as recorded by its producer.
  cliNativeTurn?: CliNativeTurnRef;
  // Native record identity of an imported row, kept apart from the composite
  // dedupe key so aggregate matching can name a single record.
  externalId?: string;
  cliSessionId?: string;
  // Set when this imported block belongs to a turn that replaced a persisted
  // aggregate: it is then the only copy of that text, so weak text dedupe must
  // not discard it against an unrelated local message repeating it.
  claimedAggregate?: boolean;
  // Local-turn facts the image correlation needs, read from the same
  // `__openclaw` record as the provenance fields above.
  entryId?: string;
  hasImageMediaFacts?: boolean;
};

type TimestampSummary = {
  hasMissingTimestamp: boolean;
  buckets: Map<number, { min: number; max: number }>;
};

type RoleTextIndex = Map<string, Map<string, TimestampSummary>>;

function normalizeContentBlockType(block: unknown): string | undefined {
  const record = asOptionalRecord(block);
  if (!record) {
    return undefined;
  }
  const normalized = readStringValue(record.type)?.toLowerCase();
  return normalized ? normalized.replace(/_/g, "") : undefined;
}

// One walk over the content blocks yields both facts the merge needs from them:
// the display text, and whether the row is the tool-result-only shape that
// continues an assistant turn rather than starting a new one.
function summarizeContent(rawContent: unknown): {
  textParts: string[];
  toolResultOnly: boolean;
} {
  const directText = readStringValue(rawContent);
  if (directText !== undefined) {
    return { textParts: [directText], toolResultOnly: false };
  }
  if (!Array.isArray(rawContent)) {
    return { textParts: [], toolResultOnly: false };
  }
  const textParts: string[] = [];
  let toolResultOnly = rawContent.length > 0;
  for (const block of rawContent) {
    toolResultOnly &&= normalizeContentBlockType(block) === "toolresult";
    if (block && typeof block === "object" && "text" in block) {
      const blockText = readStringValue(block.text);
      if (blockText !== undefined) {
        textParts.push(blockText);
      }
    }
  }
  return { textParts, toolResultOnly };
}

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

function isClaudeCliImportedUserMessage(
  role: string | undefined,
  importedFrom: string | undefined,
): boolean {
  return role === "user" && importedFrom === "claude-cli";
}

// Every raw field arrives already read by `prepareComparableMessage`, so the
// comparable view — text plus the image-mention facts the merge correlates on —
// costs no second property read.
function extractComparableText(params: {
  rawText: unknown;
  contentTextParts: string[];
  role: string | undefined;
  meta: Record<string, unknown> | undefined;
  importedFrom: string | undefined;
}): {
  hasCliImageMentions: boolean;
  cliImageTurnKey?: string;
  text?: string;
} {
  const { rawText, contentTextParts, role, meta, importedFrom } = params;
  const parts = [...contentTextParts];
  const text = readStringValue(rawText);
  if (text !== undefined) {
    parts.unshift(text);
  }
  if (parts.length === 0) {
    return { hasCliImageMentions: false };
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return { hasCliImageMentions: false };
  }
  const importedUserMessage = isClaudeCliImportedUserMessage(role, importedFrom);
  const stripResult = importedUserMessage
    ? stripTrailingCliImageMentions(joined)
    : { text: joined, stripped: false };
  const visible = stripInlineDirectiveTagsForDisplay(
    role === "user" ? stripInboundMetadata(stripResult.text) : stripResult.text,
  ).text;
  const normalized = visible.replace(/\s+/g, " ").trim();
  const storedImageTurnKey = normalizeOptionalString(meta?.cliImageTurnKey);
  return {
    hasCliImageMentions: stripResult.stripped,
    ...(stripResult.stripped && importedUserMessage
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
  // Each raw field is read exactly once here; every derived fact below reuses
  // these locals so the merge keeps its one-read-per-field invariant.
  const record = message as {
    role?: unknown;
    text?: unknown;
    content?: unknown;
    timestamp?: unknown;
    api?: unknown;
    idempotencyKey?: unknown;
    cliNativeTurn?: unknown;
  };
  const role = readStringValue(record.role);
  const content = summarizeContent(record.content);
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const importedFrom = normalizeOptionalString(meta?.importedFrom);
  const comparableText = extractComparableText({
    rawText: record.text,
    contentTextParts: content.textParts,
    role,
    meta,
    importedFrom,
  });
  return {
    message,
    order,
    externalIdentityKey,
    hasCliImageMentions: comparableText.hasCliImageMentions,
    ...(comparableText.cliImageTurnKey ? { cliImageTurnKey: comparableText.cliImageTurnKey } : {}),
    role,
    text: comparableText.text,
    timestamp: asFiniteNumber(record.timestamp),
    isCliAggregate: isPersistedCliAggregate(record.api, record.idempotencyKey),
    isToolResultOnly: role === "user" && content.toolResultOnly,
    cliNativeTurn: readCliNativeTurnRef(record.cliNativeTurn),
    externalId: normalizeOptionalString(meta?.externalId),
    cliSessionId: normalizeOptionalString(meta?.cliSessionId),
    entryId: normalizeOptionalString(meta?.id),
    hasImageMediaFacts: hasPersistedImageMediaFacts(role, meta),
  };
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
function resolveImportedExternalIdentityKey(message: unknown): string | undefined {
  const meta = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"]);
  const externalId = normalizeOptionalString(meta?.externalId);
  return externalId
    ? JSON.stringify([
        externalId,
        normalizeOptionalString(meta?.importedFrom),
        normalizeOptionalString(meta?.cliSessionId),
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

// Reads the durable media facts out of the metadata `prepareComparableMessage`
// already holds, so proving a local image turn costs no second `__openclaw` read.
function hasPersistedImageMediaFacts(
  role: string | undefined,
  meta: Record<string, unknown> | undefined,
): boolean {
  if (role !== "user" || !meta) {
    return false;
  }
  return (readPersistedMediaFacts({ __openclaw: meta }) ?? []).some(isImageMediaFact);
}

// CLI backends persist each assistant turn as one synthetic aggregate
// (`api: "cli"`) whose text is the turn's text blocks joined with blank lines.
const CLI_AGGREGATE_API = "cli";
// `api: "cli"` alone is not unique to the synthetic aggregate — ordinary CLI
// assistant replies share that shape. The aggregate producer stamps
// `idempotencyKey: "cli-assistant:<runId>"`, which the transcript append copies
// onto the stored message, so that key is the authoritative discriminator.
const CLI_AGGREGATE_IDEMPOTENCY_PREFIX = "cli-assistant:";

function isPersistedCliAggregate(rawApi: unknown, rawIdempotencyKey: unknown): boolean {
  if (readStringValue(rawApi) !== CLI_AGGREGATE_API) {
    return false;
  }
  const idempotencyKey = normalizeOptionalString(rawIdempotencyKey);
  return (
    idempotencyKey !== undefined && idempotencyKey.startsWith(CLI_AGGREGATE_IDEMPOTENCY_PREFIX)
  );
}

type CliNativeTurnRef = {
  cliSessionId: string;
  terminalRecordId: string;
};

/**
 * Reads the producer-owned link from a persisted aggregate to the native turn
 * it flattens. The CLI runner records it at the one point that sees both; an
 * aggregate written before that existed, or by a backend with no native
 * transcript, simply carries nothing and is never replaced.
 */
function readCliNativeTurnRef(value: unknown): CliNativeTurnRef | undefined {
  const record = asOptionalRecord(value);
  if (!record) {
    return undefined;
  }
  const cliSessionId = normalizeOptionalString(record.cliSessionId);
  const terminalRecordId = normalizeOptionalString(record.terminalRecordId);
  return cliSessionId && terminalRecordId ? { cliSessionId, terminalRecordId } : undefined;
}

type ImportedAssistantTurn = {
  cliSessionId?: string;
  text: string;
  entries: ComparableHistoryMessage[];
};

type PartialAssistantTurn = {
  fragments: string[];
  entries: ComparableHistoryMessage[];
};

/**
 * Indexes imported assistant turns by the native record their last message came
 * from, which is the identity the producer stamped on the matching aggregate.
 * Reads no raw fields: every fact comes from the prepared entries.
 */
function indexImportedAssistantTurns(
  importedEntries: ComparableHistoryMessage[],
): Map<string, ImportedAssistantTurn> {
  const index = new Map<string, ImportedAssistantTurn>();
  let current: PartialAssistantTurn | undefined;
  const closeTurn = (): void => {
    const turn = current;
    current = undefined;
    const terminal = turn?.entries.at(-1);
    // Only a turn whose last message kept its native record id can be named by
    // an aggregate, and a turn already indexed under that id is not a new one.
    if (!turn || !terminal?.externalId || index.has(terminal.externalId)) {
      return;
    }
    index.set(terminal.externalId, {
      ...(terminal.cliSessionId ? { cliSessionId: terminal.cliSessionId } : {}),
      text: turn.fragments.join(" "),
      entries: turn.entries,
    });
  };
  for (const entry of importedEntries) {
    if (entry.role === "assistant") {
      current ??= { fragments: [], entries: [] };
      current.entries.push(entry);
      if (entry.text !== undefined) {
        current.fragments.push(entry.text);
      }
      continue;
    }
    // A tool result the importer could not pair stays a user-role record, but
    // it continues the surrounding assistant turn rather than starting a new one.
    if (current && entry.isToolResultOnly) {
      continue;
    }
    closeTurn();
  }
  closeTurn();
  return index;
}

/**
 * Resolves each persisted aggregate against the native turn its producer named.
 * Identity is the stamped record id, never text or timing, so an aggregate is
 * only ever replaced by the turn it was actually written from. The text
 * comparison that follows is a completeness check on that identified pair: a
 * trimmed or partially imported turn no longer carries the aggregate's text,
 * and the aggregate is kept as the durable copy.
 */
function findCoveredAggregates(
  localEntries: ComparableHistoryMessage[],
  importedEntries: ComparableHistoryMessage[],
): Set<ComparableHistoryMessage> {
  const turns = indexImportedAssistantTurns(importedEntries);
  const covered = new Set<ComparableHistoryMessage>();
  const claimedTurns = new Set<string>();
  for (const entry of localEntries) {
    if (entry.role !== "assistant" || entry.isCliAggregate !== true) {
      continue;
    }
    // A local row that already carries an external identity came from a
    // previous import, so it is not a locally persisted aggregate.
    const ref = entry.externalIdentityKey === undefined ? entry.cliNativeTurn : undefined;
    // Turns are consumed one-to-one: a second aggregate naming the same record
    // is a different turn the import does not hold.
    if (!ref || claimedTurns.has(ref.terminalRecordId)) {
      continue;
    }
    const turn = turns.get(ref.terminalRecordId);
    if (!turn || turn.cliSessionId !== ref.cliSessionId) {
      continue;
    }
    if (entry.text === undefined || turn.text !== entry.text) {
      continue;
    }
    claimedTurns.add(ref.terminalRecordId);
    covered.add(entry);
    for (const claimed of turn.entries) {
      claimed.claimedAggregate = true;
    }
  }
  return covered;
}

function compareHistoryMessages(a: ComparableHistoryMessage, b: ComparableHistoryMessage): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.order - b.order;
}

/**
 * Merges imported CLI transcript messages into local history without duplicating overlaps.
 * Returns `params.localMessages` (same reference) when the merge changes nothing, so
 * callers can detect imports and replacements by identity rather than by length.
 */
export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  const localEntries = params.localMessages.map((message, order) =>
    prepareComparableMessage(message, order, resolveImportedExternalIdentityKey(message)),
  );
  // The aggregate and the imported native blocks are two shapes of the same
  // turn, so per-message equality can never pair them and the turn renders
  // twice (openclaw/openclaw#123792). The producer records which native turn
  // each aggregate flattens, so the duplicate is resolved by that recorded
  // identity; dropping the covered aggregate keeps the native blocks, which
  // are the copy that carries the tool calls.
  //
  // Grouping needs every imported row prepared up front, which only pays for
  // itself when some local aggregate actually names a native turn. Every other
  // session — including every aggregate persisted before the producer recorded
  // that link — keeps the lazy, skip-on-identity path below exactly as it is.
  const importedEntries = localEntries.some((entry) => entry.cliNativeTurn)
    ? params.importedMessages.map((message, index) =>
        prepareComparableMessage(
          message,
          localEntries.length + index,
          resolveImportedExternalIdentityKey(message),
        ),
      )
    : undefined;
  const coveredAggregates = importedEntries
    ? findCoveredAggregates(localEntries, importedEntries)
    : undefined;
  const merged = coveredAggregates?.size
    ? localEntries.filter((entry) => !coveredAggregates.has(entry))
    : localEntries;
  const suppressedAggregate = merged.length !== localEntries.length;
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
    if (!entry.hasImageMediaFacts) {
      continue;
    }
    const turnKey = entry.entryId ? hashCliImageTurnEntryId(entry.entryId) : entry.cliImageTurnKey;
    if (turnKey) {
      localImageMediaCounts.set(turnKey, (localImageMediaCounts.get(turnKey) ?? 0) + 1);
    }
  }
  // Local orders stay as prepared, so appending must start past the whole local
  // range: after a suppression `merged.length` is short of it and would collide.
  let nextOrder = localEntries.length;
  let addedImportedMessage = false;
  for (const [index, message] of params.importedMessages.entries()) {
    const prepared = importedEntries?.[index];
    const externalIdentityKey = prepared
      ? prepared.externalIdentityKey
      : resolveImportedExternalIdentityKey(message);
    if (externalIdentityKey && exactExternalIdentityIndex.has(externalIdentityKey)) {
      continue;
    }
    const imported = prepared ?? prepareComparableMessage(message, nextOrder, externalIdentityKey);
    imported.order = nextOrder;
    const turnKey = imported.hasCliImageMentions ? imported.cliImageTurnKey : undefined;
    const matches = turnKey ? localImageMediaCounts.get(turnKey) : undefined;
    if (turnKey && matches) {
      // Each local image turn suppresses one import. Counts preserve repeated
      // keys without retaining or shifting rows that matching never inspects.
      localImageMediaCounts.set(turnKey, matches - 1);
      continue;
    }
    // A block whose turn replaced an aggregate is the only surviving copy of
    // that text, so weak role/text dedupe must not discard it as well.
    const duplicate =
      imported.claimedAggregate !== true &&
      (imported.externalIdentityKey
        ? hasRoleTextCandidate(identitylessRoleTextIndex, imported)
        : hasRoleTextCandidate(allMessageRoleTextIndex, imported));
    if (!imported.hasCliImageMentions && duplicate) {
      continue;
    }
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
    addedImportedMessage = true;
  }
  if (!addedImportedMessage && !suppressedAggregate) {
    return params.localMessages;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
