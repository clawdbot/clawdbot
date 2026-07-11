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

export function serializeJsonlEntries(jsonlEntries: readonly unknown[]): string {
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

export async function writeJsonlEntry(
  filePath: string,
  entry: unknown,
  options?: WriteJsonlFileOptions,
): Promise<void> {
  await fs.writeFile(filePath, serializeJsonlEntry(entry), {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
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

export async function appendJsonlEntry(filePath: string, entry: unknown): Promise<void> {
  await appendSerializedJsonlEntry(filePath, serializeJsonlEntry(entry));
}

export async function appendSerializedJsonlEntry(
  filePath: string,
  serializedEntry: string,
): Promise<void> {
  const handle = await fs.open(filePath, "a+", 0o600);
  try {
    const stat = await handle.stat();
    let prefixNewline = false;
    if (stat.size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(lastByte, 0, 1, stat.size - 1);
      prefixNewline = bytesRead === 1 && lastByte[0] !== 0x0a;
    }
    await handle.appendFile(`${prefixNewline ? "\n" : ""}${serializedEntry}`, "utf-8");
  } finally {
    await handle.close();
  }
}
