import {
  MAX_DIFF_RENDER_LINES,
  type DiffLine,
  type DiffLineKind,
  type DiffStat,
} from "./tool-call-diff.ts";

type PatchOperation = "add" | "delete" | "update";

type PatchSection = {
  operation: PatchOperation;
  sourcePath: string;
  path: string;
  lines: DiffLine[];
  stat: DiffStat;
};

type PatchCollector = {
  sections: PatchSection[];
  storedRows: number;
  truncated: boolean;
};

type HunkState = {
  oldLine?: number;
  newLine?: number;
  oldLeft?: number;
  newLeft?: number;
};

export type PatchViewData = {
  paths: string[];
  lines: DiffLine[];
  stat: DiffStat;
  move?: { from: string; to: string };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function splitLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function startSection(
  collector: PatchCollector,
  operation: PatchOperation,
  path: string,
): PatchSection {
  const normalizedPath = path.trim();
  const section: PatchSection = {
    operation,
    sourcePath: normalizedPath,
    path: normalizedPath,
    lines: [],
    stat: { added: 0, removed: 0 },
  };
  collector.sections.push(section);
  return section;
}

function pushLine(collector: PatchCollector, section: PatchSection, line: DiffLine): void {
  if (line.kind === "add") {
    section.stat.added += 1;
  } else if (line.kind === "del") {
    section.stat.removed += 1;
  }
  if (collector.storedRows < MAX_DIFF_RENDER_LINES) {
    section.lines.push(line);
    collector.storedRows += 1;
  } else {
    collector.truncated = true;
  }
}

function separateHunk(collector: PatchCollector, section: PatchSection): void {
  if (section.lines.length === 0 || section.lines.at(-1)?.kind === "skip") {
    return;
  }
  pushLine(collector, section, { kind: "skip", text: "" });
}

function parseHunkHeader(raw: string): HunkState {
  const match = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) {
    return {};
  }
  return {
    oldLine: Number.parseInt(match[1], 10),
    oldLeft: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
    newLine: Number.parseInt(match[3], 10),
    newLeft: match[4] === undefined ? 1 : Number.parseInt(match[4], 10),
  };
}

function pushHunkLine(
  collector: PatchCollector,
  section: PatchSection,
  raw: string,
  hunk: HunkState,
): void {
  let kind: DiffLineKind;
  let lineNo: number | undefined;
  if (raw.startsWith("+")) {
    kind = "add";
    lineNo = hunk.newLine;
    if (hunk.newLine !== undefined) {
      hunk.newLine += 1;
      hunk.newLeft = Math.max(0, (hunk.newLeft ?? 0) - 1);
    }
  } else if (raw.startsWith("-")) {
    kind = "del";
    lineNo = hunk.oldLine;
    if (hunk.oldLine !== undefined) {
      hunk.oldLine += 1;
      hunk.oldLeft = Math.max(0, (hunk.oldLeft ?? 0) - 1);
    }
  } else {
    kind = "ctx";
    lineNo = hunk.newLine;
    if (hunk.oldLine !== undefined && hunk.newLine !== undefined) {
      hunk.oldLine += 1;
      hunk.newLine += 1;
      hunk.oldLeft = Math.max(0, (hunk.oldLeft ?? 0) - 1);
      hunk.newLeft = Math.max(0, (hunk.newLeft ?? 0) - 1);
    }
  }
  pushLine(collector, section, {
    kind,
    ...(lineNo !== undefined ? { lineNo } : {}),
    text: raw === "" ? "" : raw.slice(1),
  });
}

function hunkComplete(hunk: HunkState): boolean {
  return hunk.oldLeft !== undefined && hunk.oldLeft === 0 && hunk.newLeft === 0;
}

function sectionLabel(section: PatchSection): string {
  if (section.operation === "update" && section.path !== section.sourcePath) {
    return `Move ${section.sourcePath} → ${section.path}`;
  }
  const verb =
    section.operation === "add" ? "Add" : section.operation === "delete" ? "Delete" : "Update";
  return `${verb} ${section.path}`;
}

function finish(collector: PatchCollector): PatchViewData | null {
  if (collector.sections.length === 0) {
    return null;
  }
  const paths = [...new Set(collector.sections.map((section) => section.path).filter(Boolean))];
  const stat = collector.sections.reduce(
    (sum, section) => ({
      added: sum.added + section.stat.added,
      removed: sum.removed + section.stat.removed,
    }),
    { added: 0, removed: 0 },
  );
  const lines: DiffLine[] = [];
  let clipped = collector.truncated;
  const append = (line: DiffLine) => {
    if (lines.length < MAX_DIFF_RENDER_LINES) {
      lines.push(line);
    } else {
      clipped = true;
    }
  };
  for (const section of collector.sections) {
    if (collector.sections.length > 1) {
      if (lines.length > 0 && lines.at(-1)?.kind !== "skip") {
        append({ kind: "skip", text: "" });
      }
      append({ kind: "file", text: sectionLabel(section) });
    }
    for (const line of section.lines) {
      append(line);
    }
  }
  if (clipped && lines.at(-1)?.kind !== "skip") {
    lines.push({ kind: "skip", text: "" });
  }
  const only = collector.sections.length === 1 ? collector.sections[0] : undefined;
  const move =
    only && only.operation === "update" && only.sourcePath !== only.path
      ? { from: only.sourcePath, to: only.path }
      : undefined;
  return { paths, lines, stat, ...(move ? { move } : {}) };
}

function parseCodexPatch(text: string): PatchViewData | null {
  const collector: PatchCollector = { sections: [], storedRows: 0, truncated: false };
  let current: PatchSection | null = null;
  let mode: PatchOperation | "outside" = "outside";
  let hunk: HunkState | null = null;
  for (const raw of splitLines(text)) {
    const structural = mode === "update" ? raw.trimEnd() : raw.trim();
    const fileMatch = structural.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (fileMatch) {
      mode = fileMatch[1].toLowerCase() as PatchOperation;
      current = startSection(collector, mode, fileMatch[2]);
      hunk = null;
      continue;
    }
    const moveMatch = mode === "update" ? structural.match(/^\*\*\* Move to: (.+)$/) : null;
    if (moveMatch && current) {
      current.path = moveMatch[1].trim();
      continue;
    }
    if (
      structural === "*** Begin Patch" ||
      structural === "*** End Patch" ||
      structural === "*** End of File" ||
      structural.startsWith("*** Environment ID:")
    ) {
      continue;
    }
    if (!current) {
      continue;
    }
    if (mode === "update" && raw.startsWith("@@")) {
      separateHunk(collector, current);
      hunk = parseHunkHeader(raw);
      continue;
    }
    if (mode === "add" && raw.startsWith("+")) {
      pushLine(collector, current, {
        kind: "add",
        lineNo: current.stat.added + 1,
        text: raw.slice(1),
      });
    } else if (
      mode === "update" &&
      (raw === "" || raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" "))
    ) {
      const activeHunk = hunk ?? {};
      pushHunkLine(collector, current, raw, activeHunk);
      if (hunk && hunkComplete(hunk)) {
        hunk = null;
      }
    }
  }
  return finish(collector);
}

function normalizeUnifiedPath(raw: string): string {
  const path = raw.split("\t", 1)[0]?.trim() ?? "";
  return path.replace(/^[ab]\//, "");
}

function applyHeaderPair(
  collector: PatchCollector,
  current: PatchSection | null,
  oldHeader: string,
  newHeader: string,
  reuseCurrent: boolean,
): PatchSection {
  const oldPath = normalizeUnifiedPath(oldHeader.slice(4));
  const newPath = normalizeUnifiedPath(newHeader.slice(4));
  const operation: PatchOperation =
    oldPath === "/dev/null" ? "add" : newPath === "/dev/null" ? "delete" : "update";
  const targetPath = newPath === "/dev/null" ? oldPath : newPath;
  const section =
    reuseCurrent && current ? current : startSection(collector, operation, targetPath);
  section.operation = operation;
  section.sourcePath = oldPath || section.sourcePath;
  section.path = targetPath || section.path;
  return section;
}

function parseUnifiedPatch(text: string): PatchViewData | null {
  const collector: PatchCollector = { sections: [], storedRows: 0, truncated: false };
  const rawLines = splitLines(text);
  let current: PatchSection | null = null;
  let hunk: HunkState | null = null;
  let awaitingGitHeaders = false;
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index];
    const gitHeader = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (gitHeader) {
      current = startSection(collector, "update", gitHeader[2]);
      current.sourcePath = gitHeader[1];
      hunk = null;
      awaitingGitHeaders = true;
      continue;
    }
    const next = rawLines[index + 1];
    if (!hunk && raw.startsWith("--- ") && next?.startsWith("+++ ")) {
      current = applyHeaderPair(collector, current, raw, next, awaitingGitHeaders);
      awaitingGitHeaders = false;
      index += 1;
      continue;
    }
    if (raw.startsWith("@@")) {
      if (current) {
        separateHunk(collector, current);
      }
      hunk = parseHunkHeader(raw);
      awaitingGitHeaders = false;
      continue;
    }
    if (/^index |^new file mode |^deleted file mode |^similarity index /.test(raw)) {
      continue;
    }
    if (current && hunk && (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" "))) {
      pushHunkLine(collector, current, raw, hunk);
      if (hunkComplete(hunk)) {
        hunk = null;
      }
    }
  }
  return finish(collector);
}

function readOperation(value: unknown): PatchOperation {
  const raw = typeof value === "string" ? value : asRecord(value)?.type;
  return raw === "add" || raw === "delete" ? raw : "update";
}

function readStat(value: unknown): DiffStat | null {
  const record = asRecord(value);
  const added = record?.added;
  const removed = record?.removed;
  return typeof added === "number" && typeof removed === "number" && added >= 0 && removed >= 0
    ? { added: Math.trunc(added), removed: Math.trunc(removed) }
    : null;
}

function appendStructuredUpdate(
  collector: PatchCollector,
  section: PatchSection,
  diff: string,
): void {
  let hunk: HunkState | null = null;
  for (const raw of splitLines(diff)) {
    if (raw.startsWith("@@")) {
      separateHunk(collector, section);
      hunk = parseHunkHeader(raw);
    } else if (hunk && (raw.startsWith("+") || raw.startsWith("-") || raw.startsWith(" "))) {
      pushHunkLine(collector, section, raw, hunk);
      if (hunkComplete(hunk)) {
        hunk = null;
      }
    }
  }
}

function parseStructuredPatch(changes: unknown[]): PatchViewData | null {
  const collector: PatchCollector = { sections: [], storedRows: 0, truncated: false };
  for (const value of changes) {
    const record = asRecord(value);
    const sourcePath = readString(record?.path)?.trim();
    if (!record || !sourcePath) {
      continue;
    }
    const operation = readOperation(record.kind);
    const section = startSection(collector, operation, sourcePath);
    const movePath = readString(
      asRecord(record.kind)?.move_path ?? asRecord(record.kind)?.movePath,
    );
    if (movePath) {
      section.path = movePath.trim();
    }
    if (typeof record.diff === "string") {
      if (operation === "update") {
        appendStructuredUpdate(collector, section, record.diff);
      } else {
        const kind = operation === "add" ? "add" : "del";
        for (const [index, text] of splitLines(record.diff).entries()) {
          pushLine(collector, section, { kind, lineNo: index + 1, text });
        }
      }
    }
    const exactStat = readStat(record.stat);
    if (exactStat) {
      section.stat = exactStat;
    }
    collector.truncated ||= record.diffTruncated === true;
  }
  return finish(collector);
}

export function parsePatchView(args: unknown): PatchViewData | null {
  const record = asRecord(args);
  if (!record) {
    return null;
  }
  if (Array.isArray(record.changes)) {
    const structured = parseStructuredPatch(record.changes);
    if (structured) {
      return structured;
    }
  }
  const text = readString(record.patch) ?? readString(record.input) ?? readString(record.diff);
  if (!text) {
    return null;
  }
  const isCodex = /(?:^|\n)\s*\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/.test(
    text,
  );
  return isCodex ? parseCodexPatch(text) : parseUnifiedPatch(text);
}
