import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { normalizeOptionalString, readStringValue } from "../shared/string-coerce.js";

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

function resolveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveComparableTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return resolveFiniteNumber((message as { timestamp?: unknown }).timestamp);
}

function resolveComparableRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return readStringValue((message as { role?: unknown }).role);
}

function resolveImportedExternalId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const meta =
    "__openclaw" in message &&
    (message as { __openclaw?: unknown })["__openclaw"] &&
    typeof (message as { __openclaw?: unknown })["__openclaw"] === "object"
      ? ((message as { __openclaw?: Record<string, unknown> })["__openclaw"] ?? {})
      : undefined;
  return normalizeOptionalString(meta?.externalId);
}

function isEquivalentImportedMessage(existing: unknown, imported: unknown): boolean {
  const importedExternalId = resolveImportedExternalId(imported);
  if (importedExternalId && resolveImportedExternalId(existing) === importedExternalId) {
    return true;
  }

  const existingRole = resolveComparableRole(existing);
  const importedRole = resolveComparableRole(imported);
  if (!existingRole || existingRole !== importedRole) {
    return false;
  }

  const existingText = extractComparableText(existing);
  const importedText = extractComparableText(imported);
  if (!existingText || !importedText || existingText !== importedText) {
    return false;
  }

  const existingTimestamp = resolveComparableTimestamp(existing);
  const importedTimestamp = resolveComparableTimestamp(imported);
  if (existingTimestamp === undefined || importedTimestamp === undefined) {
    return true;
  }

  return Math.abs(existingTimestamp - importedTimestamp) <= DEDUPE_TIMESTAMP_WINDOW_MS;
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
  if (aTimestamp !== undefined && bTimestamp === undefined) {
    return -1;
  }
  if (aTimestamp === undefined && bTimestamp !== undefined) {
    return 1;
  }
  return a.order - b.order;
}

export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  if (params.importedMessages.length === 0) {
    return params.localMessages;
  }
  const merged = params.localMessages.map((message, index) => ({ message, order: index }));
  let nextOrder = merged.length;
  for (const imported of params.importedMessages) {
    if (merged.some((existing) => isEquivalentImportedMessage(existing.message, imported))) {
      continue;
    }
    merged.push({ message: imported, order: nextOrder });
    nextOrder += 1;
  }
  merged.sort(compareHistoryMessages);
  return merged.map((entry) => entry.message);
}
