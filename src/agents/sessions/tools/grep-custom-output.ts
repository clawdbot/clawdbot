import type { GrepToolDetails } from "./tool-contracts.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateLine,
  type TruncationResult,
} from "./truncate.js";

export type GrepSearchMatch = {
  filePath: string;
  lineNumber: number;
  lineText?: string;
};

export function splitGrepFileLines(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function createBoundedGrepOutput(): {
  append: (line: string) => boolean;
  hasOutput: () => boolean;
  result: () => TruncationResult;
  truncated: () => boolean;
} {
  const lines: string[] = [];
  let outputBytes = 0;
  let totalBytes = 0;
  let totalLines = 0;
  let truncated = false;

  return {
    append: (line) => {
      const lineBytes = Buffer.byteLength(line, "utf8");
      totalBytes += lineBytes + (totalLines > 0 ? 1 : 0);
      totalLines += 1;
      if (truncated) {
        return false;
      }
      const nextOutputBytes = outputBytes + lineBytes + (lines.length > 0 ? 1 : 0);
      if (nextOutputBytes > DEFAULT_MAX_BYTES) {
        truncated = true;
        return false;
      }
      lines.push(line);
      outputBytes = nextOutputBytes;
      return true;
    },
    hasOutput: () => lines.length > 0,
    result: () => ({
      content: lines.join("\n"),
      truncated,
      truncatedBy: truncated ? "bytes" : null,
      totalLines,
      totalBytes,
      outputLines: lines.length,
      outputBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: truncated && lines.length === 0,
      maxLines: Number.MAX_SAFE_INTEGER,
      maxBytes: DEFAULT_MAX_BYTES,
    }),
    truncated: () => truncated,
  };
}

export async function formatCustomGrepMatches({
  matches,
  matchLimitReached,
  contextValue,
  effectiveLimit,
  formatPath,
  readFile,
  signal,
}: {
  matches: GrepSearchMatch[];
  matchLimitReached: boolean;
  contextValue: number;
  effectiveLimit: number;
  formatPath: (filePath: string) => string;
  readFile: (filePath: string, options?: { signal?: AbortSignal }) => Promise<string> | string;
  signal?: AbortSignal;
}) {
  const fileCache = new Map<string, string[]>();
  const getFileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      try {
        const content = await readFile(filePath, { signal });
        lines = splitGrepFileLines(content);
      } catch {
        lines = [];
      }
      fileCache.set(filePath, lines);
    }
    return lines;
  };

  if (matches.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No matches found" }],
      details: undefined,
    };
  }
  let linesTruncated = false;
  const output = createBoundedGrepOutput();
  const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
    const relativePath = formatPath(filePath);
    const lines = await getFileLines(filePath);
    if (!lines.length) {
      return [`${relativePath}:${lineNumber}: (unable to read file)`];
    }
    const block: string[] = [];
    const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
    const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
    for (let current = start; current <= end; current++) {
      const lineText = lines[current - 1] ?? "";
      const sanitized = lineText.replace(/\r/g, "");
      const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) {
        linesTruncated = true;
      }
      block.push(
        current === lineNumber
          ? `${relativePath}:${current}: ${truncatedText}`
          : `${relativePath}-${current}- ${truncatedText}`,
      );
    }
    return block;
  };

  if (contextValue > 0) {
    const matchesByFile = new Map<string, number[]>();
    for (const match of matches) {
      const lineNumbers = matchesByFile.get(match.filePath) ?? [];
      lineNumbers.push(match.lineNumber);
      matchesByFile.set(match.filePath, lineNumbers);
    }
    for (const [filePath, observedLineNumbers] of matchesByFile) {
      const fileLines = await getFileLines(filePath);
      const relativePath = formatPath(filePath);
      if (!fileLines.length) {
        for (const lineNumber of observedLineNumbers) {
          if (!output.append(`${relativePath}:${lineNumber}: (unable to read file)`)) {
            break;
          }
        }
        fileCache.delete(filePath);
        if (output.truncated()) {
          break;
        }
        continue;
      }
      const matchLineNumbers = new Set(observedLineNumbers);
      const ranges = [...matchLineNumbers]
        .toSorted((left, right) => left - right)
        .map((lineNumber) => ({
          start: Math.max(1, lineNumber - contextValue),
          end: Math.min(fileLines.length, lineNumber + contextValue),
        }))
        .reduce<Array<{ start: number; end: number }>>((merged, range) => {
          const previous = merged.at(-1);
          if (previous && range.start <= previous.end + 1) {
            previous.end = Math.max(previous.end, range.end);
          } else {
            merged.push(range);
          }
          return merged;
        }, []);
      for (const range of ranges) {
        if (output.hasOutput() && !output.append("--")) {
          break;
        }
        for (let current = range.start; current <= range.end; current++) {
          const lineText = fileLines[current - 1] ?? "";
          const sanitized = lineText.replace(/\r/g, "");
          const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
          if (wasTruncated) {
            linesTruncated = true;
          }
          if (
            !output.append(
              matchLineNumbers.has(current)
                ? `${relativePath}:${current}: ${truncatedText}`
                : `${relativePath}-${current}- ${truncatedText}`,
            )
          ) {
            break;
          }
        }
        if (output.truncated()) {
          break;
        }
      }
      fileCache.delete(filePath);
      if (output.truncated()) {
        break;
      }
    }
  } else {
    for (const match of matches) {
      if (match.lineText !== undefined) {
        const relativePath = formatPath(match.filePath);
        const sanitized = match.lineText
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "")
          .replace(/\n$/, "");
        const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
        if (wasTruncated) {
          linesTruncated = true;
        }
        output.append(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
      } else {
        for (const line of await formatBlock(match.filePath, match.lineNumber)) {
          if (!output.append(line)) {
            break;
          }
        }
        fileCache.delete(match.filePath);
      }
      if (output.truncated()) {
        break;
      }
    }
  }

  const truncation = output.result();
  let outputText = truncation.content;
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matchLimitReached) {
    notices.push(
      `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
    );
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(
      `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
    );
    details.linesTruncated = true;
  }
  if (notices.length > 0) {
    outputText += `\n\n[${notices.join(". ")}]`;
  }
  return {
    content: [{ type: "text" as const, text: outputText }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}
