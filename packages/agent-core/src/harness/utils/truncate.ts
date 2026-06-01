export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

/** Result metadata for content truncated by line count, byte count, or both. */
export interface TruncationResult {
  /** The truncated content */
  content: string;
  /** Whether truncation occurred */
  truncated: boolean;
  /** Which limit was hit: "lines", "bytes", or null if not truncated */
  truncatedBy: "lines" | "bytes" | null;
  /** Total number of lines in the original content */
  totalLines: number;
  /** Total number of bytes in the original content */
  totalBytes: number;
  /** Number of complete lines in the truncated output */
  outputLines: number;
  /** Number of bytes in the truncated output */
  outputBytes: number;
  /** Whether the last line was partially truncated (only for tail truncation edge case) */
  lastLinePartial: boolean;
  /** Whether the first line exceeded the byte limit (for head truncation) */
  firstLineExceedsLimit: boolean;
  /** The max lines limit that was applied */
  maxLines: number;
  /** The max bytes limit that was applied */
  maxBytes: number;
}

/** Byte and line ceilings used by the truncation helpers. */
export interface TruncationOptions {
  /** Maximum number of lines (default: 2000) */
  maxLines?: number;
  /** Maximum number of bytes (default: 50KB) */
  maxBytes?: number;
}

interface ResolvedTruncationInput {
  lines: string[];
  totalLines: number;
  totalBytes: number;
  maxLines: number;
  maxBytes: number;
}

interface RuntimeBuffer {
  byteLength(content: string, encoding: "utf8"): number;
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function findFirstNonAscii(content: string): number {
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) > 0x7f) {
      return index;
    }
  }
  return -1;
}

function utf8ByteLength(content: string): number {
  if (runtimeBuffer) {
    return runtimeBuffer.byteLength(content, "utf8");
  }

  const firstNonAscii = findFirstNonAscii(content);
  if (firstNonAscii === -1) {
    return content.length;
  }

  let bytes = firstNonAscii;
  for (let i = firstNonAscii; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
      const next = content.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function replaceUnpairedSurrogates(content: string): string {
  let output = "";
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 < content.length) {
        const next = content.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          output += content[i] + content[i + 1];
          i++;
          continue;
        }
      }
      output += "�";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "�";
    } else {
      output += content[i];
    }
  }
  return output;
}

/**
 * Format byte counts for compact tool-output diagnostics.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function resolveTruncationInput(
  content: string,
  options: TruncationOptions,
): ResolvedTruncationInput {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = utf8ByteLength(content);
  const lines = splitLinesForCounting(content);
  return {
    lines,
    totalLines: lines.length,
    totalBytes,
    maxLines,
    maxBytes,
  };
}

function buildTruncationResult(
  input: ResolvedTruncationInput,
  params: {
    content: string;
    truncated: boolean;
    truncatedBy: TruncationResult["truncatedBy"];
    outputLines: number;
    outputBytes?: number;
    lastLinePartial?: boolean;
    firstLineExceedsLimit?: boolean;
  },
): TruncationResult {
  return {
    content: params.content,
    truncated: params.truncated,
    truncatedBy: params.truncatedBy,
    totalLines: input.totalLines,
    totalBytes: input.totalBytes,
    outputLines: params.outputLines,
    outputBytes: params.outputBytes ?? utf8ByteLength(params.content),
    lastLinePartial: params.lastLinePartial ?? false,
    firstLineExceedsLimit: params.firstLineExceedsLimit ?? false,
    maxLines: input.maxLines,
    maxBytes: input.maxBytes,
  };
}

/**
 * Keep the beginning of content while respecting independent line and byte ceilings.
 *
 * Head truncation preserves complete lines; a first line that exceeds the byte
 * ceiling produces empty output and sets firstLineExceedsLimit.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const input = resolveTruncationInput(content, options);

  if (input.totalLines <= input.maxLines && input.totalBytes <= input.maxBytes) {
    return buildTruncationResult(input, {
      content,
      truncated: false,
      truncatedBy: null,
      outputLines: input.totalLines,
      outputBytes: input.totalBytes,
    });
  }

  const firstLineBytes = utf8ByteLength(input.lines[0]);
  if (firstLineBytes > input.maxBytes) {
    return buildTruncationResult(input, {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
    });
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = input.totalLines > input.maxLines ? "lines" : "bytes";

  for (let i = 0; i < input.lines.length && i < input.maxLines; i++) {
    const line = input.lines[i];
    const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 for newline

    if (outputBytesCount + lineBytes > input.maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }

  if (
    input.totalLines > input.maxLines &&
    outputLinesArr.length >= input.maxLines &&
    outputBytesCount <= input.maxBytes
  ) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");

  return buildTruncationResult(input, {
    content: outputContent,
    truncated: true,
    truncatedBy,
    outputLines: outputLinesArr.length,
  });
}

/**
 * Keep the end of content while respecting independent line and byte ceilings.
 *
 * Tail truncation preserves recent output for command errors and may keep a
 * partial first line when one final line alone exceeds the byte ceiling.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const input = resolveTruncationInput(content, options);

  if (input.totalLines <= input.maxLines && input.totalBytes <= input.maxBytes) {
    return buildTruncationResult(input, {
      content,
      truncated: false,
      truncatedBy: null,
      outputLines: input.totalLines,
      outputBytes: input.totalBytes,
    });
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = input.totalLines > input.maxLines ? "lines" : "bytes";
  let lastLinePartial = false;

  for (let i = input.lines.length - 1; i >= 0 && outputLinesArr.length < input.maxLines; i--) {
    const line = input.lines[i];
    const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

    if (outputBytesCount + lineBytes > input.maxBytes) {
      truncatedBy = "bytes";
      // Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
      // take the end of the line (partial)
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, input.maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = utf8ByteLength(truncatedLine);
        lastLinePartial = true;
      }
      break;
    }

    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (
    input.totalLines > input.maxLines &&
    outputLinesArr.length >= input.maxLines &&
    outputBytesCount <= input.maxBytes
  ) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");

  return buildTruncationResult(input, {
    content: outputContent,
    truncated: true,
    truncatedBy,
    outputLines: outputLinesArr.length,
    lastLinePartial,
  });
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let outputBytes = 0;
  let start = str.length;
  let needsReplacement = false;
  for (let i = str.length; i > 0; ) {
    let characterStart = i - 1;
    const code = str.charCodeAt(characterStart);
    let characterBytes: number;
    let unpairedSurrogate = false;
    if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
      const previous = str.charCodeAt(characterStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) {
        characterStart--;
        characterBytes = 4;
      } else {
        characterBytes = 3;
        unpairedSurrogate = true;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      characterBytes = 3;
      unpairedSurrogate = true;
    } else {
      characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    }
    if (outputBytes + characterBytes > maxBytes) {
      break;
    }
    outputBytes += characterBytes;
    start = characterStart;
    needsReplacement ||= unpairedSurrogate;
    i = characterStart;
  }

  const output = str.slice(start);
  return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

/**
 * Trim a single display line and mark it with the grep-style truncation suffix.
 */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
