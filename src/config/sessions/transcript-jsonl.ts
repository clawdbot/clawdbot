import { appendFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";

type WriteJsonlFileOptions = {
  encoding?: BufferEncoding;
  flag?: string;
  mode?: number;
};

export function serializeJsonlEntry(entry: unknown): string {
  return `${serializeJsonlLine(entry)}\n`;
}

export function serializeJsonlLine(entry: unknown): string {
  return JSON.stringify(entry);
}

export function serializeJsonlEntries(entries: readonly unknown[]): string {
  return serializeJsonlLines(entries.map(serializeJsonlLine));
}

export function serializeJsonlLines(lines: readonly string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function writeJsonlEntriesSync(filePath: string, entries: readonly unknown[]): void {
  writeFileSync(filePath, serializeJsonlEntries(entries), "utf-8");
}

export function appendJsonlEntrySync(filePath: string, entry: unknown): void {
  appendFileSync(filePath, serializeJsonlEntry(entry), "utf-8");
}

export function appendJsonlEntriesSync(filePath: string, entries: readonly unknown[]): void {
  if (entries.length === 0) {
    return;
  }
  appendFileSync(filePath, serializeJsonlEntries(entries), "utf-8");
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
): Promise<void> {
  await fs.writeFile(filePath, serializeJsonlLines(lines), {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
}

export async function appendJsonlEntry(filePath: string, entry: unknown): Promise<void> {
  await fs.appendFile(filePath, serializeJsonlEntry(entry), "utf-8");
}
