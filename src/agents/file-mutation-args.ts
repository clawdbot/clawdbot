import path from "node:path";
import {
  asOptionalObjectRecord,
  readStringField,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { extractApplyPatchTargetPaths } from "./apply-patch-paths.js";
import type { FileMutationToolName } from "./tool-mutation-names.js";

type FileMutationLineCount = { added: number; removed: number };
type FileMutationDelta = FileMutationLineCount & { files: string[] };

function readTarget(record: Record<string, unknown>): string | undefined {
  const target = normalizeOptionalString(record.path ?? record.file_path ?? record.filePath);
  return target ? path.resolve(target) : undefined;
}

function readEdits(args: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = Array.isArray(args.edits) ? args.edits : [args];
  return candidates.flatMap((candidate) => {
    const edit = asOptionalObjectRecord(candidate);
    return edit ? [edit] : [];
  });
}

function countNewlines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  let count = 0;
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

/** Counts only newline-terminated content so partial streamed JSON never guesses a line. */
export function countStreamingFileMutationLines(
  kind: FileMutationToolName,
  args: Record<string, unknown>,
): FileMutationLineCount {
  if (kind === "write") {
    return { added: countNewlines(readStringField(args, "content")), removed: 0 };
  }
  if (kind === "edit") {
    return readEdits(args).reduce<FileMutationLineCount>(
      (total, edit) => ({
        added: total.added + countNewlines(edit.newText ?? edit.new_string),
        removed: total.removed + countNewlines(edit.oldText ?? edit.old_string),
      }),
      { added: 0, removed: 0 },
    );
  }
  const patch = args.input ?? args.patch;
  if (typeof patch !== "string") {
    return { added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  let lineStart = 0;
  for (let lineEnd = patch.indexOf("\n"); lineEnd >= 0; lineEnd = patch.indexOf("\n", lineStart)) {
    added += Number(patch[lineStart] === "+");
    removed += Number(patch[lineStart] === "-");
    lineStart = lineEnd + 1;
  }
  return { added, removed };
}

function readCodexChangeDelta(args: Record<string, unknown>): FileMutationDelta | undefined {
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const candidate of Array.isArray(args.changes) ? args.changes : []) {
    const change = asOptionalObjectRecord(candidate);
    const target = change ? readTarget(change) : undefined;
    if (!change || !target) {
      continue;
    }
    files.push(target);
    const stat = asOptionalObjectRecord(change.stat);
    added +=
      typeof stat?.added === "number" && Number.isFinite(stat.added) ? Math.max(0, stat.added) : 0;
    removed +=
      typeof stat?.removed === "number" && Number.isFinite(stat.removed)
        ? Math.max(0, stat.removed)
        : 0;
  }
  return files.length > 0 ? { files, added, removed } : undefined;
}

/** Reads complete tool arguments using task-fold line semantics. */
export function readCompletedFileMutationDelta(
  kind: FileMutationToolName,
  args: Record<string, unknown>,
): FileMutationDelta | undefined {
  if (kind === "apply_patch") {
    const patch = readStringField(args, "input");
    if (patch === undefined) {
      return readCodexChangeDelta(args);
    }
    const files = extractApplyPatchTargetPaths(args);
    if (files.length === 0) {
      return undefined;
    }
    let added = 0;
    let removed = 0;
    let inBody = false;
    for (const line of patch.split(/\r\n|\r|\n/)) {
      if (/^\s*\*\*\* (?:Add|Update|Delete) File: /.test(line)) {
        inBody = true;
      } else if (!/^\s*\*\* /.test(line) && inBody) {
        added += Number(line.startsWith("+"));
        removed += Number(line.startsWith("-"));
      }
    }
    return { files, added, removed };
  }
  const target = readTarget(args);
  if (!target) {
    return undefined;
  }
  if (kind === "write") {
    const content = readStringField(args, "content");
    return content === undefined
      ? undefined
      : {
          files: [target],
          added: content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length,
          removed: 0,
        };
  }
  let added = 0;
  let removed = 0;
  let hasCompleteEdit = false;
  for (const edit of readEdits(args)) {
    const oldText =
      typeof edit.oldText === "string"
        ? edit.oldText
        : typeof edit.old_string === "string"
          ? edit.old_string
          : undefined;
    const newText =
      typeof edit.newText === "string"
        ? edit.newText
        : typeof edit.new_string === "string"
          ? edit.new_string
          : undefined;
    if (oldText === undefined || newText === undefined) {
      continue;
    }
    hasCompleteEdit = true;
    added += newText.length === 0 ? 0 : newText.split(/\r\n|\r|\n/).length;
    removed += oldText.length === 0 ? 0 : oldText.split(/\r\n|\r|\n/).length;
  }
  return hasCompleteEdit ? { files: [target], added, removed } : undefined;
}
