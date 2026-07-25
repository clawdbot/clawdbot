// Imported CLI history merge helpers.
// Deduplicates external history messages against local OpenClaw transcripts.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { redactSensitiveText } from "../logging/redact.js";

const DEDUPE_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

function extractComparableText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { role?: unknown; text?: unknown; content?: unknown };
  const role = readStringValue(record.role);
  const parts: string[] = [];
  const text = readStringValue(record.text);
  if (text !== undefined) {
    parts.push(text);
  }
  const content = readStringValue(record.content);
  if (content !== undefined) {
    parts.push(content);
  } else if (Array.isArray(record.content)) {
    for (const block of record.content) {
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
  const visible = role === "user" ? stripInboundMetadata(joined) : joined;
  const normalized = visible.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function resolveComparableTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return asFiniteNumber((message as { timestamp?: unknown }).timestamp);
}

function resolveComparableRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return readStringValue((message as { role?: unknown }).role);
}

// External identity survives text edits, so it is the strongest match signal
// for imported messages from Claude CLI or similar external histories.
type ImportedExternalIdentity = {
  externalId: string;
  importedFrom?: string;
  cliSessionId?: string;
};

function resolveImportedExternalIdentity(message: unknown): ImportedExternalIdentity | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const meta =
    "__openclaw" in message &&
    (message as { __openclaw?: unknown })["__openclaw"] &&
    typeof (message as { __openclaw?: unknown })["__openclaw"] === "object"
      ? ((message as { __openclaw?: Record<string, unknown> })["__openclaw"] ?? {})
      : undefined;
  const externalId = normalizeOptionalString(meta?.externalId);
  return externalId
    ? {
        externalId,
        importedFrom: normalizeOptionalString(meta?.importedFrom),
        cliSessionId: normalizeOptionalString(meta?.cliSessionId),
      }
    : undefined;
}

function hasSameExternalIdentity(existing: unknown, imported: unknown): boolean {
  const importedIdentity = resolveImportedExternalIdentity(imported);
  const existingIdentity = resolveImportedExternalIdentity(existing);
  if (!importedIdentity || !existingIdentity) {
    return false;
  }
  return (
    importedIdentity.externalId === existingIdentity.externalId &&
    importedIdentity.importedFrom === existingIdentity.importedFrom &&
    importedIdentity.cliSessionId === existingIdentity.cliSessionId
  );
}

function hasConflictingExternalIdentity(existing: unknown, imported: unknown): boolean {
  const existingIdentity = resolveImportedExternalIdentity(existing);
  const importedIdentity = resolveImportedExternalIdentity(imported);
  return Boolean(
    existingIdentity && importedIdentity && !hasSameExternalIdentity(existing, imported),
  );
}

type ImportedMessageMatch = "lossless" | "lossy-redaction";

function resolveImportedMessageMatch(
  existing: unknown,
  imported: unknown,
): ImportedMessageMatch | undefined {
  if (hasSameExternalIdentity(existing, imported)) {
    return "lossless";
  }

  const existingRole = resolveComparableRole(existing);
  const importedRole = resolveComparableRole(imported);
  if (!existingRole || existingRole !== importedRole) {
    return undefined;
  }

  const existingText = extractComparableText(existing);
  const importedText = extractComparableText(imported);
  if (!existingText || !importedText) {
    return undefined;
  }
  let textMatch: ImportedMessageMatch;
  if (existingText === importedText) {
    textMatch = "lossless";
  } else if (hasConflictingExternalIdentity(existing, imported)) {
    return undefined;
  } else if (
    existingText === redactSensitiveText(importedText) ||
    redactSensitiveText(existingText) === importedText
  ) {
    // Compare each original with one redaction pass of the other; never compare
    // two redacted results because masking is lossy and not idempotent.
    textMatch = "lossy-redaction";
  } else {
    return undefined;
  }

  const existingTimestamp = resolveComparableTimestamp(existing);
  const importedTimestamp = resolveComparableTimestamp(imported);
  if (existingTimestamp === undefined || importedTimestamp === undefined) {
    return textMatch;
  }

  return Math.abs(existingTimestamp - importedTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS
    ? textMatch
    : undefined;
}

function redactionVariantKey(role: string, redactedText: string): string {
  return `${role}\0${redactedText}`;
}

function resolveLossyRedactionMatch(
  existing: unknown,
  imported: unknown,
): { key: string; masked: unknown } | undefined {
  const existingRole = resolveComparableRole(existing);
  if (!existingRole || existingRole !== resolveComparableRole(imported)) {
    return undefined;
  }
  const existingText = extractComparableText(existing);
  const importedText = extractComparableText(imported);
  if (!existingText || !importedText) {
    return undefined;
  }
  if (existingText === redactSensitiveText(importedText)) {
    return { key: redactionVariantKey(existingRole, existingText), masked: existing };
  }
  return redactSensitiveText(existingText) === importedText
    ? { key: redactionVariantKey(existingRole, importedText), masked: imported }
    : undefined;
}

type RedactionVariant = { message: unknown; text: string };
type RedactionVariantIndex = Map<string, RedactionVariant[]>;

function collectRedactionVariants(messages: unknown[]): RedactionVariantIndex {
  const variants: RedactionVariantIndex = new Map();
  for (const message of messages) {
    const role = resolveComparableRole(message);
    const text = extractComparableText(message);
    if (!role || !text) {
      continue;
    }
    const redacted = redactSensitiveText(text);
    if (redacted === text) {
      continue;
    }
    const key = redactionVariantKey(role, redacted);
    const entries = variants.get(key) ?? [];
    entries.push({ message, text });
    variants.set(key, entries);
  }
  return variants;
}

function haveCompatibleTimestamps(left: unknown, right: unknown): boolean {
  const leftTimestamp = resolveComparableTimestamp(left);
  const rightTimestamp = resolveComparableTimestamp(right);
  return (
    leftTimestamp === undefined ||
    rightTimestamp === undefined ||
    Math.abs(leftTimestamp - rightTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS
  );
}

function hasUniqueCompatibleRedactionVariant(params: {
  existing: unknown;
  imported: unknown;
  variants: RedactionVariantIndex;
  cache: Map<unknown, Map<string, boolean>>;
}): boolean {
  const lossyMatch = resolveLossyRedactionMatch(params.existing, params.imported);
  if (!lossyMatch) {
    return false;
  }
  const cachedByKey = params.cache.get(lossyMatch.masked);
  const cached = cachedByKey?.get(lossyMatch.key);
  if (cached !== undefined) {
    return cached;
  }
  const compatibleTexts = new Set<string>();
  for (const variant of params.variants.get(lossyMatch.key) ?? []) {
    if (!haveCompatibleTimestamps(lossyMatch.masked, variant.message)) {
      continue;
    }
    compatibleTexts.add(variant.text);
    if (compatibleTexts.size > 1) {
      break;
    }
  }
  const unique = compatibleTexts.size === 1;
  const nextCachedByKey = cachedByKey ?? new Map<string, boolean>();
  nextCachedByKey.set(lossyMatch.key, unique);
  params.cache.set(lossyMatch.masked, nextCachedByKey);
  return unique;
}

function compareHistoryMessages(
  a: { message: unknown; order: number },
  b: { message: unknown; order: number },
): number {
  const aTimestamp = resolveComparableTimestamp(a.message);
  const bTimestamp = resolveComparableTimestamp(b.message);
  if (aTimestamp !== undefined && bTimestamp !== undefined && aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
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
  const merged = params.localMessages.map((message, index) => ({ message, order: index }));
  const redactionVariants = collectRedactionVariants([
    ...params.localMessages,
    ...params.importedMessages,
  ]);
  const redactionVariantCache = new Map<unknown, Map<string, boolean>>();

  let nextOrder = merged.length;
  for (const imported of params.importedMessages) {
    const duplicate = merged.some((existing) => {
      const match = resolveImportedMessageMatch(existing.message, imported);
      if (match === "lossless") {
        return true;
      }
      if (match !== "lossy-redaction") {
        return false;
      }
      // A mask is not an identity. Only collapse it when every observed full
      // representation agrees; collisions stay visible rather than being guessed.
      return hasUniqueCompatibleRedactionVariant({
        existing: existing.message,
        imported,
        variants: redactionVariants,
        cache: redactionVariantCache,
      });
    });
    if (duplicate) {
      continue;
    }
    merged.push({ message: imported, order: nextOrder });
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
