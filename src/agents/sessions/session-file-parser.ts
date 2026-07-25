import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { FileEntry } from "./session-manager.js";

type SessionFileParseWarning = {
  code: "invalid-session-json" | "invalid-session-row";
  row: number;
};

function isSessionFileEntry(value: unknown): value is FileEntry {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type !== "message") {
    return true;
  }
  return isRecord(value.message) && typeof value.message.role === "string";
}

export function parseSessionFileEntriesWithWarnings(content: string): {
  entries: FileEntry[];
  warnings: SessionFileParseWarning[];
  rowByEntry: Map<FileEntry, number>;
} {
  const entries: FileEntry[] = [];
  const warnings: SessionFileParseWarning[] = [];
  const rowByEntry = new Map<FileEntry, number>();
  const rows = content.split(/\r?\n/u);
  for (const [index, rawLine] of rows.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as unknown;
      if (!isSessionFileEntry(entry)) {
        warnings.push({ code: "invalid-session-row", row: index + 1 });
        continue;
      }
      entries.push(entry);
      rowByEntry.set(entry, index + 1);
    } catch {
      warnings.push({ code: "invalid-session-json", row: index + 1 });
    }
  }
  return { entries, warnings, rowByEntry };
}
