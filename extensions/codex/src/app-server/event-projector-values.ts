import {
  asFiniteNumber,
  normalizeOptionalString,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type CodexThreadItem, type JsonObject, type JsonValue } from "./protocol.js";

export { normalizeOptionalString as normalizeNonEmptyString };

export function readNonEmptyString(record: JsonObject, key: string): string | undefined {
  return normalizeOptionalString(record[key]);
}

export function readNonEmptyStringArray(record: JsonObject, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry);
    if (normalized) {
      entries.push(normalized);
    }
  }
  return entries;
}

export function readNullableString(record: JsonObject, key: string): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

export function readNonNegativeInteger(record: JsonObject, key: string): number | undefined {
  const value = asFiniteNumber(record[key]);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function readCodexErrorNotificationMessage(record: JsonObject): string | undefined {
  const error = record.error;
  return isJsonObject(error) ? readStringField(error, "message") : undefined;
}

export function readHookOutputEntries(
  value: JsonValue | undefined,
): Array<{ kind?: string; text: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isJsonObject(entry)) {
      return [];
    }
    const text = readStringField(entry, "text");
    if (!text) {
      return [];
    }
    const kind = readStringField(entry, "kind");
    return [{ ...(kind ? { kind } : {}), text }];
  });
}

export function splitPlanText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0);
}

export function extractRawAssistantText(item: JsonObject): string | undefined {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content.flatMap((entry) => {
    if (!isJsonObject(entry)) {
      return [];
    }
    const type = readStringField(entry, "type");
    if (type !== "output_text" && type !== "text") {
      return [];
    }
    const value = readStringField(entry, "text");
    return value === undefined ? [] : [value];
  });
  return parts.length > 0 ? parts.join("").trim() : undefined;
}

export function readItemString(item: CodexThreadItem, key: string): string | undefined {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function readItem(value: JsonValue | undefined): CodexThreadItem | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const type = typeof value.type === "string" ? value.type : undefined;
  const id = typeof value.id === "string" ? value.id : undefined;
  if (!type || !id) {
    return undefined;
  }
  return value as CodexThreadItem;
}
