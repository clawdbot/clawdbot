import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export type DirectoryEntry = {
  name: string;
  isDirectory: boolean;
};

/** Decode the sandbox directory command's metadata, never file contents. */
export function parseDirectoryEntries(text: string): DirectoryEntry[] {
  const entries: unknown = JSON.parse(text);
  if (!Array.isArray(entries)) {
    throw new Error("Invalid sandbox directory listing.");
  }
  return entries.map((entry: unknown) => {
    const record = asNullableRecord(entry);
    if (!record || typeof record.name !== "string" || typeof record.isDirectory !== "boolean") {
      throw new Error("Invalid sandbox directory entry.");
    }
    return { name: record.name, isDirectory: record.isDirectory };
  });
}
