import { SourceMap, type SourceMapPayload } from "node:module";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { QuickJS } from "quickjs-wasi";
import type { CodeModeLanguage } from "./code-mode-worker-types.js";

export const USER_SOURCE_FILE = "openclaw-code-mode:user.js";
const GENERATED_SOURCE_FILE = "openclaw-code-mode:generated.js";
export const SOURCE_LOCATION_KEY = "__openclawSourceLocation";

export type SourceLocation = {
  file: typeof USER_SOURCE_FILE | typeof GENERATED_SOURCE_FILE;
  lineOffset: number;
  lineCount: number;
  columnOffset: number;
  endColumn: number;
  sourceMap?: string;
  generatedLines?: string[];
};

function sourceExtent(source: string): { lines: number; lastColumn: number } {
  let lines = 1;
  let lastLineStart = 0;
  for (const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/gu)) {
    lines += 1;
    lastLineStart = match.index + match[0].length;
  }
  // QuickJS columns count UTF-8 bytes, while JavaScript string indices count UTF-16 units.
  return { lines, lastColumn: Buffer.byteLength(source.slice(lastLineStart), "utf8") + 1 };
}

export function readSourceLocation(vm: QuickJS): SourceLocation | undefined {
  // Old snapshots have no record. Read data descriptors without invoking guest getters.
  const descriptor = vm.global.getOwnPropertyDescriptor(SOURCE_LOCATION_KEY);
  if (!descriptor) {
    return undefined;
  }
  try {
    if (
      descriptor.writable ||
      descriptor.configurable ||
      descriptor.enumerable ||
      !descriptor.value?.isString
    ) {
      return undefined;
    }
    const value: unknown = JSON.parse(descriptor.value.toString());
    if (!isRecord(value)) {
      return undefined;
    }
    const { file, lineOffset, lineCount, columnOffset, endColumn } = value;
    const isOffset = (offset: unknown): offset is number =>
      typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0;
    if (
      (file !== USER_SOURCE_FILE && file !== GENERATED_SOURCE_FILE) ||
      !isOffset(lineOffset) ||
      !isOffset(lineCount) ||
      lineCount === 0 ||
      !isOffset(columnOffset) ||
      !isOffset(endColumn) ||
      endColumn === 0 ||
      !Number.isSafeInteger(lineOffset + lineCount) ||
      (lineCount === 1 && endColumn <= columnOffset)
    ) {
      return undefined;
    }
    return {
      file,
      lineOffset,
      lineCount,
      columnOffset,
      endColumn,
      ...(typeof value.sourceMap === "string" &&
      Array.isArray(value.generatedLines) &&
      value.generatedLines.every((line) => typeof line === "string")
        ? { sourceMap: value.sourceMap, generatedLines: value.generatedLines }
        : {}),
    };
  } catch {
    return undefined;
  } finally {
    descriptor.value?.dispose();
    descriptor.get?.dispose();
    descriptor.set?.dispose();
  }
}

export function normalizeSourceStack(
  stack: string | undefined,
  location?: SourceLocation,
): string | undefined {
  if (!stack || !location) {
    return stack;
  }
  // SAFETY: The TypeScript compiler produces this v3 map; the immutable VM property
  // is written before guest evaluation and travels in the bounded snapshot.
  const map = location.sourceMap
    ? new SourceMap(JSON.parse(location.sourceMap) as SourceMapPayload) // SAFETY: compiler-produced v3 map, immutable before guest execution.
    : undefined;
  // Leave arbitrary guest stack text opaque instead of copying every line into an array.
  return stack.replace(
    /^[^\S\r\n]+at [^\r\n]*openclaw-code-mode:(?:user|controller)\.js:\d+:\d+\)?(?:\r?\n|$)/gmu,
    (frame) => {
      const match = /openclaw-code-mode:user\.js:(\d+):(\d+)(?=\)?(?:\r?\n)?$)/u.exec(frame);
      if (!match) {
        return "";
      }
      const line = Number(match[1]) - location.lineOffset;
      const originalColumn = Number(match[2]);
      const column = originalColumn - (line === 1 ? location.columnOffset : 0);
      if (
        line < 1 ||
        line > location.lineCount ||
        column < 1 ||
        (line === location.lineCount && originalColumn > location.endColumn)
      ) {
        return "";
      }
      if (map) {
        // QuickJS uses UTF-8 byte columns; v3 source maps use UTF-16 columns.
        const lineText = location.generatedLines?.[line - 1] ?? "";
        const utf16Column = Buffer.from(lineText)
          .subarray(0, column - 1)
          .toString("utf8").length;
        const original = map.findEntry(line - 1, utf16Column);
        if ("originalLine" in original) {
          return frame.replace(
            match[0],
            "openclaw-code-mode:user.ts:" +
              (original.originalLine + 1) +
              ":" +
              (original.originalColumn + 1),
          );
        }
      }
      return frame.replace(match[0], location.file + ":" + line + ":" + column);
    },
  );
}

export function buildUserSource(
  code: string,
  prelude = "",
  language?: CodeModeLanguage,
): { source: string; location: SourceLocation } {
  const prefix = `globalThis.__openclawResult = (async () => {\n${prelude}`;
  const before = sourceExtent(prefix);
  const body = sourceExtent(code);
  const columnOffset = before.lastColumn - 1;
  return {
    source: `${prefix}${code}\n})()`,
    location: {
      file: language === "typescript" ? GENERATED_SOURCE_FILE : USER_SOURCE_FILE,
      lineOffset: before.lines - 1,
      lineCount: body.lines,
      columnOffset,
      endColumn: body.lastColumn + (body.lines === 1 ? columnOffset : 0),
    },
  };
}
