/** Raw targets from the apply_patch envelope grammar. */
type ApplyPatchTarget = {
  kind: "add" | "delete" | "move" | "update";
  path: string;
};

const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";

function readPatchText(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && "input" in input) {
    const candidate = (input as { input?: unknown }).input;
    return typeof candidate === "string" ? candidate : undefined;
  }
  return undefined;
}

function normalizeMarkerHeaderLine(line: string | undefined): string | undefined {
  if (line === undefined) {
    return undefined;
  }
  const startTrimmed = line.trimStart();
  return startTrimmed.startsWith("***") ? startTrimmed.trimEnd() : undefined;
}

function readMarkerPath(line: string | undefined, marker: string): string | undefined {
  const candidate = normalizeMarkerHeaderLine(line);
  return candidate?.startsWith(marker) ? candidate.slice(marker.length) : undefined;
}

/** Walk the executor-compatible envelope grammar without resolving its paths. */
export function extractApplyPatchTargets(input: unknown): ApplyPatchTarget[] {
  const text = readPatchText(input);
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const targets: ApplyPatchTarget[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines.at(index);
    const addPath = readMarkerPath(line, ADD_FILE_MARKER);
    if (addPath !== undefined) {
      targets.push({ kind: "add", path: addPath });
      while (index + 1 < lines.length && lines.at(index + 1)?.startsWith("+")) {
        index += 1;
      }
      continue;
    }
    const deletePath = readMarkerPath(line, DELETE_FILE_MARKER);
    if (deletePath !== undefined) {
      targets.push({ kind: "delete", path: deletePath });
      continue;
    }
    const updatePath = readMarkerPath(line, UPDATE_FILE_MARKER);
    if (updatePath === undefined) {
      continue;
    }
    targets.push({ kind: "update", path: updatePath });
    let lookahead = index + 1;
    while (lookahead < lines.length && lines.at(lookahead)?.trim() === "") {
      lookahead += 1;
    }
    const movePath = readMarkerPath(lines.at(lookahead), MOVE_TO_MARKER);
    if (movePath !== undefined) {
      targets.push({ kind: "move", path: movePath });
      lookahead += 1;
    }
    while (lookahead < lines.length) {
      const lookaheadLine = lines.at(lookahead);
      if (lookaheadLine === undefined || lookaheadLine.startsWith("***")) {
        break;
      }
      lookahead += 1;
    }
    index = lookahead - 1;
  }
  return targets;
}
