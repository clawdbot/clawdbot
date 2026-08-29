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
};

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

function prepareComparableMessage(message: unknown, order: number): ComparableHistoryMessage {
  if (!message || typeof message !== "object") {
    return { message, order, hasCliImageMentions: false };
  }
  const record = message as { role?: unknown; timestamp?: unknown };
  const role = readStringValue(record.role);
  const comparableText = extractComparableText(message, role);
  return {
    message,
    order,
    externalIdentityKey: resolveImportedExternalIdentityKey(message),
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

function findLocalImageMediaMatch(
  candidates: ComparableHistoryMessage[],
  imported: ComparableHistoryMessage,
): number {
  if (!imported.hasCliImageMentions || !imported.cliImageTurnKey) {
    return -1;
  }
  return candidates.findIndex(
    (candidate) => candidate.cliImageTurnKey === imported.cliImageTurnKey,
  );
}

function compareHistoryMessages(a: ComparableHistoryMessage, b: ComparableHistoryMessage): number {
  if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }
  return a.order - b.order;
}

/** Merges imported CLI transcript messages into local history without duplicating overlaps. */
export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  const merged = params.localMessages.map(prepareComparableMessage);
  const exactExternalIdentityIndex = new Set<string>();
  const allMessageRoleTextIndex: RoleTextIndex = new Map();
  const identitylessRoleTextIndex: RoleTextIndex = new Map();
  const localImageMediaCandidates: ComparableHistoryMessage[] = [];
  const indexEntry = (entry: ComparableHistoryMessage) => {
    if (entry.externalIdentityKey) {
      exactExternalIdentityIndex.add(entry.externalIdentityKey);
    } else {
      addRoleTextCandidate(identitylessRoleTextIndex, entry);
    }
    addRoleTextCandidate(allMessageRoleTextIndex, entry);
  };
  for (const entry of merged) {
    const localMeta = asOptionalRecord(asOptionalRecord(entry.message)?.["__openclaw"]);
    const localEntryId = normalizeOptionalString(localMeta?.id);
    if (localEntryId) {
      entry.cliImageTurnKey = hashCliImageTurnEntryId(localEntryId);
    }
    indexEntry(entry);
    if (hasLocalImageMediaFacts(entry)) {
      localImageMediaCandidates.push(entry);
    }
  }
  let nextOrder = merged.length;
  for (const message of params.importedMessages) {
    const imported = prepareComparableMessage(message, nextOrder);
    if (
      imported.externalIdentityKey &&
      exactExternalIdentityIndex.has(imported.externalIdentityKey)
    ) {
      continue;
    }
    const localImageMediaIndex = findLocalImageMediaMatch(localImageMediaCandidates, imported);
    if (localImageMediaIndex !== -1) {
      localImageMediaCandidates.splice(localImageMediaIndex, 1);
      continue;
    }
    const duplicate = imported.externalIdentityKey
      ? hasRoleTextCandidate(identitylessRoleTextIndex, imported)
      : hasRoleTextCandidate(allMessageRoleTextIndex, imported);
    if (!imported.hasCliImageMentions && duplicate) {
      continue;
    }
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
