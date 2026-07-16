import { isJsonObject, type CodexThreadItem, type JsonObject, type JsonValue } from "./protocol.js";

export function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || undefined;
}

export function readNonEmptyString(record: JsonObject, key: string): string | undefined {
  return normalizeNonEmptyString(record[key]);
}

export function readNonEmptyStringArray(record: JsonObject, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of value) {
    const normalized = normalizeNonEmptyString(entry);
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

export function readNumber(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readNonNegativeInteger(record: JsonObject, key: string): number | undefined {
  const value = readNumber(record, key);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function readCodexErrorNotificationMessage(record: JsonObject): string | undefined {
  const error = record.error;
  return isJsonObject(error) ? readString(error, "message") : undefined;
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
    const text = readString(entry, "text");
    if (!text) {
      return [];
    }
    const kind = readString(entry, "kind");
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
  const text = content
    .flatMap((entry) => {
      if (!isJsonObject(entry)) {
        return [];
      }
      const type = readString(entry, "type");
      if (type !== "output_text" && type !== "text") {
        return [];
      }
      const value = readString(entry, "text");
      return value ? [value] : [];
    })
    .join("");
  return text.trim() || undefined;
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
