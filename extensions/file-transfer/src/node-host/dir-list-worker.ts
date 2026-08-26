// File Transfer plugin module lists one canonically bound directory.
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createCanonicalDirListCommand } from "./dir-list-worker-command.js";

const CANONICAL_PATH_CHANGED_EXIT_CODE = 78;
const DIR_LIST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type CanonicalDirListEntry = {
  name: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
};

type CanonicalDirListResult =
  | { ok: true; entries: CanonicalDirListEntry[]; total: number }
  | { ok: false; code: "CANONICAL_PATH_CHANGED" | "READ_ERROR" };

export async function listCanonicalDirectory(input: {
  directoryPath: string;
  expectedCanonicalPath: string;
  expectedDevice: string;
  expectedInode: string;
  maxEntries: number;
  offset: number;
}): Promise<CanonicalDirListResult> {
  // The worker binds cwd before validating it. Relative listing and metadata
  // reads therefore stay on that directory object if its path is replaced.
  const result = await runCommandBuffered(createCanonicalDirListCommand(input), {
    discardOutput: { stderr: true },
    maxOutputBytes: { stdout: DIR_LIST_MAX_OUTPUT_BYTES, stderr: 64 * 1024 },
    timeoutMs: 60_000,
  }).catch(() => null);
  if (result?.termination === "exit" && result.code === CANONICAL_PATH_CHANGED_EXIT_CODE) {
    return { ok: false, code: "CANONICAL_PATH_CHANGED" };
  }
  if (!result || result.termination !== "exit" || result.code !== 0) {
    return { ok: false, code: "READ_ERROR" };
  }
  try {
    const parsed = asNullableRecord(JSON.parse(result.stdout.toString("utf8")));
    if (!parsed || !Array.isArray(parsed.entries) || typeof parsed.total !== "number") {
      return { ok: false, code: "READ_ERROR" };
    }
    const entries: CanonicalDirListEntry[] = [];
    for (const value of parsed.entries) {
      const entry = asNullableRecord(value);
      if (
        !entry ||
        typeof entry.name !== "string" ||
        typeof entry.isDirectory !== "boolean" ||
        typeof entry.size !== "number" ||
        typeof entry.mtimeMs !== "number"
      ) {
        return { ok: false, code: "READ_ERROR" };
      }
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      });
    }
    return { ok: true, entries, total: parsed.total };
  } catch {
    return { ok: false, code: "READ_ERROR" };
  }
}
