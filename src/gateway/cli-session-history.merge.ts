// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  missingTimestamp?: ComparableHistoryMessage;
  buckets: Map<number, { min: ComparableHistoryMessage; max: ComparableHistoryMessage }>;
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
    summary = { buckets: new Map() };
    byText.set(entry.text, summary);
  }
  if (entry.timestamp === undefined) {
    summary.missingTimestamp ??= entry;
    return;
  }
  const bucketKey = Math.floor(entry.timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  const bucket = summary.buckets.get(bucketKey);
  if (bucket) {
    if ((bucket.min.timestamp ?? Number.POSITIVE_INFINITY) > entry.timestamp) {
      bucket.min = entry;
    }
    if ((bucket.max.timestamp ?? Number.NEGATIVE_INFINITY) < entry.timestamp) {
      bucket.max = entry;
    }
  } else {
    summary.buckets.set(bucketKey, { min: entry, max: entry });
  }
}

function findRoleTextCandidate(
  index: RoleTextIndex,
  entry: ComparableHistoryMessage,
): ComparableHistoryMessage | undefined {
  if (!entry.role || !entry.text) {
    return undefined;
  }
  const summary = index.get(entry.role)?.get(entry.text);
  if (!summary) {
    return undefined;
  }
  if (summary.missingTimestamp) {
    return summary.missingTimestamp;
  }
  if (entry.timestamp === undefined) {
    return summary.buckets.values().next().value?.min;
  }
  const bucketKey = Math.floor(entry.timestamp / DEDUPE_TIMESTAMP_WINDOW_MS);
  const current = summary.buckets.get(bucketKey);
  if (current) {
    return current.min;
  }
  const previous = summary.buckets.get(bucketKey - 1);
  if (
    previous?.max.timestamp !== undefined &&
    previous.max.timestamp >= entry.timestamp - DEDUPE_TIMESTAMP_WINDOW_MS
  ) {
    return previous.max;
  }
  const next = summary.buckets.get(bucketKey + 1);
  return next?.min.timestamp !== undefined &&
    next.min.timestamp <= entry.timestamp + DEDUPE_TIMESTAMP_WINDOW_MS
    ? next.min
    : undefined;
}

function projectImportedIdentity(localMessage: unknown, importedMessage: unknown): unknown {
  if (!isRecord(localMessage) || !isRecord(importedMessage)) {
    return localMessage;
  }
  const importedMeta = importedMessage["__openclaw"];
  if (!isRecord(importedMeta)) {
    return localMessage;
  }
  const localMeta = localMessage["__openclaw"];
  const nextMeta = isRecord(localMeta) ? { ...localMeta } : {};
  let changed = false;
  for (const field of ["importedFrom", "externalId", "cliSessionId"] as const) {
    const value = normalizeOptionalString(importedMeta[field]);
    if (value && nextMeta[field] === undefined) {
      nextMeta[field] = value;
      changed = true;
    }
  }
  return changed ? { ...localMessage, __openclaw: nextMeta } : localMessage;
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
  const exactExternalIdentityIndex = new Map<string, ComparableHistoryMessage>();
  const allMessageRoleTextIndex: RoleTextIndex = new Map();
  const identitylessRoleTextIndex: RoleTextIndex = new Map();
  const indexEntry = (entry: ComparableHistoryMessage) => {
    if (entry.externalIdentityKey) {
      exactExternalIdentityIndex.set(entry.externalIdentityKey, entry);
    } else {
      addRoleTextCandidate(identitylessRoleTextIndex, entry);
    }
    addRoleTextCandidate(allMessageRoleTextIndex, entry);
  };
  for (const entry of merged) {
    indexEntry(entry);
  }
  let changed = false;
  let nextOrder = merged.length;
  for (const message of params.importedMessages) {
    const imported = prepareComparableMessage(message, nextOrder);
    const duplicate = imported.externalIdentityKey
      ? (exactExternalIdentityIndex.get(imported.externalIdentityKey) ??
        findRoleTextCandidate(identitylessRoleTextIndex, imported))
      : findRoleTextCandidate(allMessageRoleTextIndex, imported);
    if (duplicate) {
      const projected = projectImportedIdentity(duplicate.message, imported.message);
      if (projected !== duplicate.message) {
        duplicate.message = projected;
        duplicate.externalIdentityKey = resolveImportedExternalIdentityKey(projected);
        if (duplicate.externalIdentityKey) {
          exactExternalIdentityIndex.set(duplicate.externalIdentityKey, duplicate);
        }
        changed = true;
      }
      continue;
    }
    merged.push(imported);
    indexEntry(imported);
    nextOrder += 1;
    changed = true;
  }
  if (!changed) {
    return params.localMessages;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
