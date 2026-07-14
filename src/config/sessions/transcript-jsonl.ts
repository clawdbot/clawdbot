// JSONL helpers centralize newline-safe transcript serialization and writes.
import { appendFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";

type WriteJsonlFileOptions = {
  encoding?: BufferEncoding;
  flag?: string;
  mode?: number;
};

/** Serializes one JSONL entry and appends the newline terminator. */
export function serializeJsonlEntry(entry: unknown): string {
  return `${serializeJsonlLine(entry)}\n`;
}

export function serializeJsonlLine(entry: unknown): string {
  const serialized = JSON.stringify(entry);
  // JSON.stringify returns undefined when the root value is undefined, a
  // function, or a symbol. Without this guard the template literal in
  // serializeJsonlEntry coerces it to the literal string "undefined", which is
  // not valid JSON and is silently skipped by readers — a fail-silent loss of a
  // transcript entry. Fail fast instead so the caller fixes the bad value.
  if (serialized === undefined) {
    throw new TypeError(
      `serializeJsonlLine: entry of type ${typeof entry} is not JSON-serializable (JSON.stringify returned undefined)`,
    );
  }
  return serialized;
}

function serializeJsonlEntries(jsonlEntries: readonly unknown[]): string {
  return serializeJsonlLines(jsonlEntries.map(serializeJsonlLine));
}

export function serializeJsonlLines(lines: readonly string[]): string {
  // Transcript readers expect every persisted entry batch to end with a newline.
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function writeJsonlEntriesSync(filePath: string, entries: readonly unknown[]): string {
  const content = serializeJsonlEntries(entries);
  writeFileSync(filePath, content, "utf-8");
  return content;
}

export function appendJsonlEntrySync(
  filePath: string,
  entry: unknown,
  options?: { prefixNewline?: boolean },
): string {
  return appendSerializedJsonlEntrySync(filePath, serializeJsonlEntry(entry), options);
}

export function appendSerializedJsonlEntrySync(
  filePath: string,
  serializedEntry: string,
  options?: { prefixNewline?: boolean },
): string {
  const content = options?.prefixNewline ? `\n${serializedEntry}` : serializedEntry;
  appendFileSync(filePath, content, "utf-8");
  return content;
}
export async function writeJsonlLines(
  filePath: string,
  lines: readonly string[],
  options?: WriteJsonlFileOptions,
): Promise<string> {
  const content = serializeJsonlLines(lines);
  await fs.writeFile(filePath, content, {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
  return content;
}
