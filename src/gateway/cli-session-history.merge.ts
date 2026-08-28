// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
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
  if (entry.timestamp === undefined) {
    summary.hasMissingTimestamp = true;
    return;
  }
  const bucketKey = Math.floor(entry.timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  const bucket = summary.buckets.get(bucketKey);
  if (bucket) {
    bucket.min = Math.min(bucket.min, entry.timestamp);
    bucket.max = Math.max(bucket.max, entry.timestamp);
  } else {
    summary.buckets.set(bucketKey, { min: entry.timestamp, max: entry.timestamp });
  }
}

function hasRoleTextCandidate(index: RoleTextIndex, entry: ComparableHistoryMessage): boolean {
  if (!entry.role || !entry.text) {
    return false;
  }
  const summary = index.get(entry.role)?.get(entry.text);
  if (!summary) {
    return false;
  }
  if (entry.timestamp === undefined || summary.hasMissingTimestamp) {
    return true;
  }
  const bucketKey = Math.floor(entry.timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  if (summary.buckets.has(bucketKey)) {
    return true;
  }
  const previous = summary.buckets.get(bucketKey - 1);
  if (previous && previous.max >= entry.timestamp - DEDUPE_TIMESTAMP_WINDOW_MS) {
    return true;
  }
  const next = summary.buckets.get(bucketKey + 1);
  return next !== undefined && next.min <= entry.timestamp + DEDUPE_TIMESTAMP_WINDOW_MS;
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
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
