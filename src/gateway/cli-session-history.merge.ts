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
  hasNonTextContent?: boolean;
  isToolResultOnly?: boolean;
  provider?: string;
  importedFrom?: string;
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

// One walk over the content blocks yields every fact the merge needs from them:
// the display text, whether the row carries non-text blocks, and whether it is
// the tool-result-only shape that continues an assistant turn.
function summarizeContent(rawContent: unknown): {
  hasNonText: boolean;
  textParts: string[];
  toolResultOnly: boolean;
} {
  const directText = readStringValue(rawContent);
  if (directText !== undefined) {
    return { hasNonText: false, textParts: [directText], toolResultOnly: false };
  }
  if (!Array.isArray(rawContent)) {
    return { hasNonText: false, textParts: [], toolResultOnly: false };
  }
  const textParts: string[] = [];
  let hasNonText = false;
  let toolResultOnly = rawContent.length > 0;
  for (const block of rawContent) {
    const type = normalizeContentBlockType(block);
    hasNonText ||= type !== undefined && type !== "text";
    toolResultOnly &&= type === "toolresult";
    if (block && typeof block === "object" && "text" in block) {
      const blockText = readStringValue(block.text);
      if (blockText !== undefined) {
        textParts.push(blockText);
      }
    }
  }
  return { hasNonText, textParts, toolResultOnly };
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
    provider?: unknown;
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
    hasNonTextContent: content.hasNonText,
    isToolResultOnly: role === "user" && content.toolResultOnly,
    provider: normalizeOptionalString(record.provider),
    importedFrom,
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

type PartialAssistantTurn = {
  fragments: string[];
  entries: ComparableHistoryMessage[];
  hasNonTextContent: boolean;
  importedFrom?: string;
  terminalTimestamp?: number;
};

type AggregateCandidate = {
  entry: ComparableHistoryMessage;
  timestamp: number;
};

type TurnGroup = {
  aggregateCandidates: AggregateCandidate[];
  turns: { terminalTimestamp: number; entries: ComparableHistoryMessage[] }[];
};

// Keyed by the text a covering aggregate carries and then by producer, so each
// aggregate reaches its candidates with two lookups instead of a scan that
// grows with the imported history.
type ImportedTurnIndex = Map<string, Map<string, TurnGroup>>;

function resolveTurnGroup(index: ImportedTurnIndex, text: string, provider: string): TurnGroup {
  let byProvider = index.get(text);
  if (!byProvider) {
    byProvider = new Map();
    index.set(text, byProvider);
  }
  let group = byProvider.get(provider);
  if (!group) {
    group = { aggregateCandidates: [], turns: [] };
    byProvider.set(provider, group);
  }
  return group;
}

/**
 * Indexes the imported assistant turns by the aggregate text that would cover
 * them. Reads no raw fields: every fact comes from the prepared entries.
 */
function indexImportedAssistantTurns(
  importedEntries: ComparableHistoryMessage[],
): ImportedTurnIndex {
  const index: ImportedTurnIndex = new Map();
  let current: PartialAssistantTurn | undefined;
  const closeTurn = (): void => {
    const turn = current;
    current = undefined;
    if (!turn || turn.fragments.length === 0) {
      return;
    }
    // Turns that can never cover an aggregate stay out of the index instead of
    // being re-rejected once per aggregate: no timestamp to place them in the
    // dedupe window, no provider to match, or — for a lone text-only fragment —
    // an exact-equality case the per-message dedupe already resolves by
    // keeping the local copy.
    if (turn.terminalTimestamp === undefined || turn.importedFrom === undefined) {
      return;
    }
    if (turn.fragments.length < 2 && !turn.hasNonTextContent) {
      return;
    }
    resolveTurnGroup(index, turn.fragments.join(" "), turn.importedFrom).turns.push({
      terminalTimestamp: turn.terminalTimestamp,
      entries: turn.entries,
    });
  };
  for (const entry of importedEntries) {
    if (entry.role === "assistant") {
      current ??= { fragments: [], entries: [], hasNonTextContent: false };
      current.entries.push(entry);
      if (entry.text !== undefined) {
        current.fragments.push(entry.text);
      }
      current.hasNonTextContent ||= entry.hasNonTextContent === true;
      current.importedFrom ??= entry.importedFrom;
      if (
        entry.timestamp !== undefined &&
        (current.terminalTimestamp === undefined || entry.timestamp > current.terminalTimestamp)
      ) {
        current.terminalTimestamp = entry.timestamp;
      }
      continue;
    }
    // A tool result the importer could not pair stays a user-role record, but
    // it continues the surrounding assistant turn rather than starting a new one.
    if (current && entry.isToolResultOnly) {
      current.hasNonTextContent = true;
      continue;
    }
    closeTurn();
  }
  closeTurn();
  return index;
}

/**
 * Pairs each persisted aggregate with the imported turn it duplicates. The
 * aggregate is written once the CLI turn completes, so within one text and
 * producer the two sides are matched in timestamp order: the earliest turn that
 * completed no more than the dedupe window before an aggregate owns it. Pairing
 * is one-to-one, so two genuinely repeated replies with identical text are only
 * both suppressed when the import actually holds both turns.
 */
function findCoveredAggregates(
  localEntries: ComparableHistoryMessage[],
  importedEntries: ComparableHistoryMessage[],
): Set<ComparableHistoryMessage> {
  const groups = indexImportedAssistantTurns(importedEntries);
  for (const entry of localEntries) {
    if (
      entry.role !== "assistant" ||
      entry.isCliAggregate !== true ||
      // A local row that already carries an external identity came from a
      // previous import, so it is not a locally persisted aggregate.
      entry.externalIdentityKey !== undefined ||
      entry.provider === undefined ||
      entry.text === undefined ||
      entry.timestamp === undefined
    ) {
      continue;
    }
    groups
      .get(entry.text)
      ?.get(entry.provider)
      ?.aggregateCandidates.push({ entry, timestamp: entry.timestamp });
  }

  const covered = new Set<ComparableHistoryMessage>();
  for (const byProvider of groups.values()) {
    for (const group of byProvider.values()) {
      if (group.aggregateCandidates.length === 0) {
        continue;
      }
      group.turns.sort((left, right) => left.terminalTimestamp - right.terminalTimestamp);
      group.aggregateCandidates.sort((left, right) => left.timestamp - right.timestamp);
      let turnIndex = 0;
      let aggregateIndex = 0;
      while (turnIndex < group.turns.length && aggregateIndex < group.aggregateCandidates.length) {
        const turn = group.turns[turnIndex]!;
        const aggregate = group.aggregateCandidates[aggregateIndex]!;
        const elapsed = aggregate.timestamp - turn.terminalTimestamp;
        if (elapsed < 0) {
          aggregateIndex += 1;
          continue;
        }
        if (elapsed > DEDUPE_TIMESTAMP_WINDOW_MS) {
          turnIndex += 1;
          continue;
        }
        covered.add(aggregate.entry);
        for (const entry of turn.entries) {
          entry.claimedAggregate = true;
        }
        turnIndex += 1;
        aggregateIndex += 1;
      }
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
  // twice (openclaw/openclaw#123792). Dropping the covered aggregate keeps the
  // native blocks, which are the copy that carries the tool calls.
  //
  // Grouping needs every imported row prepared up front, which only pays for
  // itself when a local aggregate could actually be covered. A session without
  // one keeps the lazy, skip-on-identity path below exactly as it is.
  const importedEntries = localEntries.some((entry) => entry.isCliAggregate)
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
