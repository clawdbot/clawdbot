// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import {
  isImageMediaFact,
  normalizeMediaFacts,
  type MediaFactInput,
} from "../media/media-facts.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

type ComparableHistoryMessage = {
  message: unknown;
  order: number;
  externalIdentityKey?: string;
  role?: string;
  text?: string;
  timestamp?: number;
};

type TimestampSummary = {
  hasMissingTimestamp: boolean;
  buckets: Map<number, { min: number; max: number }>;
};

type RoleTextIndex = Map<string, Map<string, TimestampSummary>>;

function extractComparableText(message: unknown, role: string | undefined): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
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
    return undefined;
  }
  const joined = parts.join("\n").trim();
  if (!joined) {
    return undefined;
  }
  const visible = stripInlineDirectiveTagsForDisplay(
    role === "user" ? stripInboundMetadata(joined) : joined,
  ).text;
  const normalized = visible.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function prepareComparableMessage(message: unknown, order: number): ComparableHistoryMessage {
  if (!message || typeof message !== "object") {
    return { message, order };
  }
  const record = message as { role?: unknown; timestamp?: unknown };
  const role = readStringValue(record.role);
  return {
    message,
    order,
    externalIdentityKey: resolveImportedExternalIdentityKey(message),
    role,
    text: extractComparableText(message, role),
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

function summaryMatchesTimestamp(
  summary: TimestampSummary | undefined,
  timestamp: number | undefined,
): boolean {
  if (!summary) {
    return false;
  }
  if (timestamp === undefined || summary.hasMissingTimestamp) {
    return true;
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

// Imported user rows containing only CLI-injected image cache mentions (tagged
// by the Claude importer) are redundant only when a local user row with image
// media facts represents the same turn. Local history can be reset or lost
// while the external JSONL persists, so redundancy is proven per-merge by a
// media-bearing local row inside the dedupe timestamp window, never assumed.
function isCliImageMentionOnlyImport(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const meta = (message as { __openclaw?: unknown })["__openclaw"];
  if (!meta || typeof meta !== "object") {
    return false;
  }
  return (meta as { cliImageMentionOnly?: unknown }).cliImageMentionOnly === true;
}

function hasLocalImageMediaFacts(entry: ComparableHistoryMessage): boolean {
  const message = entry.message;
  if (entry.role !== "user" || !message || typeof message !== "object") {
    return false;
  }
  const meta = (message as { __openclaw?: unknown })["__openclaw"];
  if (!meta || typeof meta !== "object") {
    return false;
  }
  const media = (meta as { media?: unknown }).media;
  if (!Array.isArray(media)) {
    return false;
  }
  return normalizeMediaFacts(media as readonly MediaFactInput[]).some(isImageMediaFact);
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
  let localImageMediaTimestamps: TimestampSummary | undefined;
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
    if (hasLocalImageMediaFacts(entry)) {
      localImageMediaTimestamps ??= { hasMissingTimestamp: false, buckets: new Map() };
      addTimestampToSummary(localImageMediaTimestamps, entry.timestamp);
    }
  }
  let nextOrder = merged.length;
  for (const message of params.importedMessages) {
    const imported = prepareComparableMessage(message, nextOrder);
    const duplicate = imported.externalIdentityKey
      ? exactExternalIdentityIndex.has(imported.externalIdentityKey) ||
        hasRoleTextCandidate(identitylessRoleTextIndex, imported)
      : hasRoleTextCandidate(allMessageRoleTextIndex, imported);
    if (duplicate) {
      continue;
    }
    if (
      isCliImageMentionOnlyImport(message) &&
      summaryMatchesTimestamp(localImageMediaTimestamps, imported.timestamp)
    ) {
      continue;
    }
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
