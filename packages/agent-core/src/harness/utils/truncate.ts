// Agent Core module implements truncate behavior.
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
  totalLines: number;
  totalBytes: number;
  maxLines: number;
  maxBytes: number;
}

interface RuntimeBuffer {
  byteLength(content: string, encoding: "utf8"): number;
}

const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;

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
          output += content.charAt(i) + content.charAt(i + 1);
          i++;
          continue;
        }
      }
      output += "�";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "�";
    } else {
      output += content.charAt(i);
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
  let totalLines = content.length > 0 && !content.endsWith("\n") ? 1 : 0;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    totalLines++;
  }
  return {
    totalLines,
    totalBytes: utf8ByteLength(content),
    maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };
}

function buildTruncationResult(
  input: ResolvedTruncationInput,
  params: {
    content: string;
    truncated: boolean;
    truncatedBy: TruncationResult["truncatedBy"];
    outputLines: number;
    outputBytes: number;
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
    outputBytes: params.outputBytes,
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

  const firstLineEnd = content.indexOf("\n");
  const firstLine = content.slice(0, firstLineEnd === -1 ? content.length : firstLineEnd);
  if (input.totalLines > 0 && utf8ByteLength(firstLine) > input.maxBytes) {
    return buildTruncationResult(input, {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
    });
  }

  const outputLines: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = input.totalLines > input.maxLines ? "lines" : "bytes";
  // Preserve slice(0, maxLines) semantics for negative and fractional ceilings.
  const lineLimit = Math.trunc(input.maxLines) || 0;
  const selectedLines = Math.min(
    input.totalLines,
    lineLimit < 0 ? input.totalLines + lineLimit : lineLimit,
  );
  for (let start = 0; outputLines.length < selectedLines;) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    const line = content.slice(start, end);
    const lineBytes = utf8ByteLength(line) + (outputLines.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > input.maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputLines.push(line);
    start = end + 1;
    outputBytesCount += lineBytes;
  }

  if (
    input.totalLines > input.maxLines &&
    outputLines.length >= input.maxLines &&
    outputBytesCount <= input.maxBytes
  ) {
    truncatedBy = "lines";
  }

  return buildTruncationResult(input, {
    content: outputLines.join("\n"),
    truncated: true,
    truncatedBy,
    outputLines: outputLines.length,
    outputBytes: outputBytesCount,
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

  const outputLines: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = input.totalLines > input.maxLines ? "lines" : "bytes";
  let lastLinePartial = false;
  // A final newline terminates the last display line; truncated output omits it.
  let end = content.length - (content.endsWith("\n") ? 1 : 0);

  while (outputLines.length < input.totalLines && outputLines.length < input.maxLines) {
    const start = end > 0 ? content.lastIndexOf("\n", end - 1) + 1 : 0;
    const line = content.slice(start, end);
    const lineBytes = utf8ByteLength(line) + (outputLines.length > 0 ? 1 : 0); // +1 for newline

    if (outputBytesCount + lineBytes > input.maxBytes) {
      truncatedBy = "bytes";
      if (outputLines.length === 0) {
        const partialLine = truncateStringToBytesFromEnd(line, input.maxBytes);
        outputLines.push(partialLine);
        outputBytesCount = utf8ByteLength(partialLine);
        lastLinePartial = true;
      }
      break;
    }

    outputLines.push(line);
    end = start - 1;
    outputBytesCount += lineBytes;
  }

  if (
    input.totalLines > input.maxLines &&
    outputLines.length >= input.maxLines &&
    outputBytesCount <= input.maxBytes
  ) {
    truncatedBy = "lines";
  }

  return buildTruncationResult(input, {
    // Join only selected lines so a multiline result does not retain the full source.
    content: outputLines.toReversed().join("\n"),
    truncated: true,
    truncatedBy,
    outputLines: outputLines.length,
    outputBytes: outputBytesCount,
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
  for (let i = str.length; i > 0;) {
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
 *
 * The cut point is backed off by one code unit when it would otherwise split a
 * surrogate pair, so emoji / CJK Extension B characters crossing the boundary
 * stay intact instead of rendering as replacement characters.
 */
export function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }
  let cut = maxChars;
  // Avoid splitting a surrogate pair at the truncation boundary.
  if (cut < line.length) {
    const lastCode = line.charCodeAt(cut - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      const nextCode = line.charCodeAt(cut);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        cut -= 1;
      }
    }
  }
  return { text: `${line.slice(0, cut)}... [truncated]`, wasTruncated: true };
}
