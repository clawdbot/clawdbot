/**
 * View-model for tool-call rows.
 *
 * Classifies a tool call into a small set of presentation kinds (command,
 * read, edit, write, search, fetch, generic) across the arg spellings used by
 * the OpenClaw session tools and foreign harnesses (Claude/Codex style).
 */

import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  buildWriteDiffLines,
  computeLineDiff,
  countTextLines,
  diffStat,
  joinDiffSections,
  MAX_DIFF_RENDER_LINES,
  parseDiffDetailsString,
  type DiffLine,
  type DiffStat,
} from "./tool-call-diff.ts";
import { parsePatchView } from "./tool-call-patch.ts";

export type ToolCallKind = "command" | "read" | "edit" | "write" | "search" | "fetch" | "generic";

type ToolCallViewSource = {
  name: string;
  args?: unknown;
  details?: unknown;
};

export type ToolCallView = {
  kind: ToolCallKind;
  /** Full command text for `command` rows (first line shown collapsed). */
  command?: string;
  /** File basename or primary target shown bold in the row. */
  target?: string;
  /** Dimmed secondary detail (directory, query scope, URL host…). */
  targetDetail?: string;
  /** Inline diff rows for edit/write calls. */
  diff?: DiffLine[];
  stat?: DiffStat;
};

const COMMAND_TOOL_NAMES = new Set(["bash", "exec", "shell", "run_command", "run_terminal_cmd"]);
const READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "notebookread", "notebook_read"]);
const EDIT_TOOL_NAMES = new Set([
  "edit",
  "edit_file",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
]);
const TEXT_EDITOR_TOOL_NAMES = new Set(["str_replace_editor", "str_replace_based_edit_tool"]);
const WRITE_TOOL_NAMES = new Set(["write", "write_file", "create_file"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "find", "glob", "ls", "list", "codebase_search"]);
const FETCH_TOOL_NAMES = new Set(["web_fetch", "webfetch", "fetch"]);
const PATCH_TOOL_NAMES = new Set(["apply_patch", "applypatch", "patch"]);

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolvePathArg(args: Record<string, unknown> | null): string | undefined {
  if (!args) {
    return undefined;
  }
  return (
    readString(args.path) ??
    readString(args.file_path) ??
    readString(args.filePath) ??
    readString(args.file) ??
    readString(args.filepath) ??
    readString(args.filename) ??
    readString(args.notebook_path)
  );
}

function splitPathForDisplay(path: string): { base: string; dir?: string } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) {
    return { base: normalized || path };
  }
  return { base: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
}

type EditPair = { oldText: string; newText: string };

type ResolvedEditDiff = { lines: DiffLine[]; stat?: DiffStat };

const MAX_LOCAL_DIFF_PAIRS = 8;
const MAX_LOCAL_DIFF_INPUT_CHARS = 120_000;

function readEditPairs(args: Record<string, unknown>): { pairs: EditPair[]; truncated: boolean } {
  const pairs: EditPair[] = [];
  let inputChars = 0;
  let truncated = false;
  const push = (oldText: unknown, newText: unknown) => {
    if (typeof oldText === "string" && typeof newText === "string") {
      const pairChars = oldText.length + newText.length;
      if (inputChars + pairChars > MAX_LOCAL_DIFF_INPUT_CHARS) {
        truncated = true;
        return;
      }
      inputChars += pairChars;
      pairs.push({ oldText, newText });
    }
  };
  if (Array.isArray(args.edits)) {
    for (let index = 0; index < args.edits.length; index++) {
      if (index >= MAX_LOCAL_DIFF_PAIRS) {
        truncated = true;
        break;
      }
      const entry = args.edits[index];
      const record = asRecord(entry);
      if (record) {
        push(
          record.oldText ?? record.old_string ?? record.oldString ?? record.old_str,
          record.newText ?? record.new_string ?? record.newString ?? record.new_str,
        );
        if (truncated) {
          break;
        }
      }
    }
  } else {
    push(
      args.oldText ?? args.old_string ?? args.oldString ?? args.old_str,
      args.newText ?? args.new_string ?? args.newString ?? args.new_str,
    );
  }
  return { pairs, truncated };
}

function readDetailsDiff(details: unknown): ResolvedEditDiff | null {
  const record = asRecord(details);
  const diffText = record ? readString(record.diff) : undefined;
  if (!diffText) {
    return null;
  }
  const lines = parseDiffDetailsString(diffText);
  if (!lines) {
    return null;
  }
  const stat = { added: 0, removed: 0 };
  for (const match of diffText.matchAll(/^([+-])\s*\d+/gm)) {
    if (match[1] === "+") {
      stat.added += 1;
    } else {
      stat.removed += 1;
    }
  }
  const truncated =
    /^\s*\.\.\.\(truncated\)\.\.\.\s*$/m.test(diffText) || lines.length > MAX_DIFF_RENDER_LINES + 1;
  return { lines, ...(truncated ? {} : { stat }) };
}

function resolveEditDiff(source: ToolCallViewSource): ResolvedEditDiff | null {
  const fromDetails = readDetailsDiff(source.details);
  if (fromDetails) {
    return fromDetails;
  }
  const args = asRecord(source.args);
  if (!args) {
    return null;
  }
  const { pairs, truncated } = readEditPairs(args);
  if (pairs.length === 0) {
    return truncated ? { lines: [{ kind: "skip", text: "" }] } : null;
  }
  const sections = pairs.map((pair) => computeLineDiff(pair.oldText, pair.newText));
  const sectionTruncated = sections.some((section) => section.at(-1)?.kind === "skip");
  const lines = joinDiffSections(sections, { truncated });
  if (lines.length === 0) {
    return null;
  }
  const stat =
    truncated || sectionTruncated
      ? undefined
      : sections.reduce(
          (sum, section) => {
            const sectionStat = diffStat(section);
            return {
              added: sum.added + sectionStat.added,
              removed: sum.removed + sectionStat.removed,
            };
          },
          { added: 0, removed: 0 },
        );
  return { lines, ...(stat ? { stat } : {}) };
}

function resolveInsertionDiff(
  source: ToolCallViewSource,
  args: Record<string, unknown> | null,
): ResolvedEditDiff | null {
  const fromDetails = readDetailsDiff(source.details);
  if (fromDetails) {
    return fromDetails;
  }
  const insertText = args ? readString(args.insert_text) : undefined;
  if (!insertText) {
    return null;
  }
  const lines = computeLineDiff("", insertText);
  // The text is known, but its surrounding file context is not. Omit an exact
  // stat rather than implying this preview represents the final placement.
  return lines.length > 0 ? { lines } : null;
}

function resolvePatchData(args: Record<string, unknown> | null) {
  return parsePatchView(args);
}

function resolvePatchView(args: Record<string, unknown> | null): ToolCallView | null {
  const patch = resolvePatchData(args);
  if (!patch) {
    return null;
  }
  if (patch.paths.length > 1) {
    return {
      kind: "edit",
      target: `${patch.paths.length} files`,
      diff: patch.lines,
      stat: patch.stat,
    };
  }
  if (patch.move) {
    const from = splitPathForDisplay(patch.move.from);
    const to = splitPathForDisplay(patch.move.to);
    const commonDir = from.dir === to.dir ? from.dir : undefined;
    return {
      kind: "edit",
      target: commonDir ? `${from.base} → ${to.base}` : `${patch.move.from} → ${patch.move.to}`,
      targetDetail: commonDir,
      diff: patch.lines,
      stat: patch.stat,
    };
  }
  const pathParts = patch.paths[0] ? splitPathForDisplay(patch.paths[0]) : null;
  return {
    kind: "edit",
    target: pathParts?.base,
    targetDetail: pathParts?.dir,
    diff: patch.lines,
    stat: patch.stat,
  };
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

type TextEditorCommand = "view" | "str_replace" | "create" | "insert" | "undo_edit";

function resolveTextEditorCommand(args: unknown): TextEditorCommand | undefined {
  const command = readString(asRecord(args)?.command)?.trim().toLowerCase();
  switch (command) {
    case "view":
    case "str_replace":
    case "create":
    case "insert":
    case "undo_edit":
      return command;
    default:
      return undefined;
  }
}

export function resolveToolCallTargetPaths(name: string, args?: unknown): string[] {
  const record = asRecord(args);
  if (PATCH_TOOL_NAMES.has(normalizeKey(name))) {
    return resolvePatchData(record)?.paths ?? [];
  }
  const path = resolvePathArg(record);
  return path ? [path] : [];
}

export function resolveToolCallKind(name: string, args?: unknown): ToolCallKind {
  const key = normalizeKey(name);
  if (TEXT_EDITOR_TOOL_NAMES.has(key)) {
    switch (resolveTextEditorCommand(args)) {
      case "view":
        return "read";
      case "str_replace":
      case "insert":
      case "undo_edit":
        return "edit";
      case "create":
        return "write";
      default:
        return "generic";
    }
  }
  if (COMMAND_TOOL_NAMES.has(key)) {
    return "command";
  }
  if (READ_TOOL_NAMES.has(key)) {
    return "read";
  }
  if (EDIT_TOOL_NAMES.has(key) || PATCH_TOOL_NAMES.has(key)) {
    return "edit";
  }
  if (WRITE_TOOL_NAMES.has(key)) {
    return "write";
  }
  if (SEARCH_TOOL_NAMES.has(key)) {
    return "search";
  }
  if (FETCH_TOOL_NAMES.has(key)) {
    return "fetch";
  }
  // Arg-shape fallback for harness-specific command tools.
  const record = asRecord(args);
  if (record && typeof record.command === "string" && Object.keys(record).length <= 3) {
    return "command";
  }
  return "generic";
}

// Cache entries remember which details object they were built from: live tool
// rows first render with args only and gain result `details` (e.g. the edit
// diff) later on the same args identity, which must invalidate the cache.
const toolCallViewCache = new WeakMap<object, { details: unknown; view: ToolCallView }>();

export function resolveToolCallView(source: ToolCallViewSource): ToolCallView {
  const args = asRecord(source.args);
  const cacheKey = args ?? asRecord(source.details);
  if (cacheKey) {
    const cached = toolCallViewCache.get(cacheKey);
    if (cached && cached.details === source.details) {
      return cached.view;
    }
  }
  const view = buildToolCallView(source, args);
  if (cacheKey) {
    toolCallViewCache.set(cacheKey, { details: source.details, view });
  }
  return view;
}

/**
 * Strip the `sh -lc '<command>'` wrapper harnesses add around agent commands
 * so rows show the command the model actually wrote. Display-only.
 */
export function unwrapShellWrapperCommand(command: string): string {
  const match = command.match(
    /^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]+)\1\s*$/,
  );
  return match?.[2] ?? command;
}

function buildToolCallView(
  source: ToolCallViewSource,
  args: Record<string, unknown> | null,
): ToolCallView {
  const kind = resolveToolCallKind(source.name, source.args);
  const key = normalizeKey(source.name);
  const editorCommand = TEXT_EDITOR_TOOL_NAMES.has(key)
    ? resolveTextEditorCommand(source.args)
    : undefined;

  if (kind === "command") {
    const command = args ? readString(args.command) : undefined;
    return { kind, command: command ? unwrapShellWrapperCommand(command) : command };
  }

  if (kind === "read") {
    const path = resolvePathArg(args);
    if (!path) {
      return { kind: "generic" };
    }
    const { base, dir } = splitPathForDisplay(path);
    return { kind, target: base, targetDetail: dir };
  }

  if (kind === "edit") {
    if (PATCH_TOOL_NAMES.has(key)) {
      return resolvePatchView(args) ?? { kind: "generic" };
    }
    const path = resolvePathArg(args);
    if (!path) {
      return { kind: "generic" };
    }
    const { base, dir } = splitPathForDisplay(path);
    const diff =
      editorCommand === "insert"
        ? resolveInsertionDiff(source, args)
        : editorCommand === "undo_edit"
          ? readDetailsDiff(source.details)
          : resolveEditDiff(source);
    return {
      kind,
      target: base,
      targetDetail: dir,
      ...(diff ? { diff: diff.lines, ...(diff.stat ? { stat: diff.stat } : {}) } : {}),
    };
  }

  if (kind === "write") {
    const path = resolvePathArg(args);
    if (!path) {
      return { kind: "generic" };
    }
    const { base, dir } = splitPathForDisplay(path);
    const authoritativeDiff = readDetailsDiff(source.details);
    if (authoritativeDiff) {
      return {
        kind,
        target: base,
        targetDetail: dir,
        diff: authoritativeDiff.lines,
        ...(authoritativeDiff.stat ? { stat: authoritativeDiff.stat } : {}),
      };
    }
    const details = asRecord(source.details);
    if (details?.changed === false) {
      return { kind, target: base, targetDetail: dir };
    }
    const content = args
      ? editorCommand === "create"
        ? readString(args.file_text)
        : readString(args.content)
      : undefined;
    if (!content) {
      return { kind, target: base, targetDetail: dir };
    }
    const diff = buildWriteDiffLines(content);
    return {
      kind,
      target: base,
      targetDetail: dir,
      diff,
      // Present details need created=true before zero removals are authoritative.
      ...(details && details.created !== true
        ? {}
        : { stat: { added: countTextLines(content), removed: 0 } }),
    };
  }

  if (kind === "search") {
    const pattern = args
      ? (readString(args.pattern) ?? readString(args.query) ?? readString(args.glob))
      : undefined;
    const path = resolvePathArg(args) ?? (args ? readString(args.path) : undefined);
    if (!pattern && !path) {
      return { kind: "generic" };
    }
    return { kind, target: pattern ?? path, targetDetail: pattern ? path : undefined };
  }

  if (kind === "fetch") {
    const url = args ? readString(args.url) : undefined;
    if (!url) {
      return { kind: "generic" };
    }
    return { kind, target: url };
  }

  return { kind: "generic" };
}
