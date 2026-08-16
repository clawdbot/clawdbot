export const DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS = 800;
export const DAILY_MEMORY_FLUSH_MAX_APPEND_LINES = 3;
export const DAILY_MEMORY_FLUSH_MAX_EXISTING_FILE_BYTES = 16 * 1024 * 1024;
const DAILY_MEMORY_FLUSH_MAX_LINE_CHARS = 500;
export type MemoryFlushAppendBudget = {
  acceptedChars: number;
  acceptedLines: number;
};

export type PreparedMemoryFlushAppend = {
  status: "accepted";
  content: string;
  appendedLines: number;
  appendChars: number;
};

export function memoryFlushAppendRejected(message: string): Error {
  return new Error(`Memory flush append rejected: ${message}`);
}

function splitLines(content: string): string[] {
  return content.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
}

function assertHardBounds(lines: readonly string[], content: string): void {
  if (lines.length === 0) {
    throw memoryFlushAppendRejected("content must include at least one non-empty line.");
  }
  if (lines.length > DAILY_MEMORY_FLUSH_MAX_APPEND_LINES) {
    throw memoryFlushAppendRejected(
      `too many lines (${lines.length}; max ${DAILY_MEMORY_FLUSH_MAX_APPEND_LINES}). Write 1-3 short pointer lines only.`,
    );
  }
  const longLine = lines.find((line) => line.length > DAILY_MEMORY_FLUSH_MAX_LINE_CHARS);
  if (longLine) {
    throw memoryFlushAppendRejected(
      `line too long (${longLine.length} chars; max ${DAILY_MEMORY_FLUSH_MAX_LINE_CHARS}). Write a short pointer instead of a transcript-style narrative.`,
    );
  }
  if (content.length > DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS) {
    throw memoryFlushAppendRejected(
      `content too large (${content.length} chars; max ${DAILY_MEMORY_FLUSH_MAX_APPEND_CHARS}). Write 1-3 short pointer lines only.`,
    );
  }
}

export function prepareDailyMemoryFlushAppend(params: {
  content: string;
  existingContent: string;
}): PreparedMemoryFlushAppend {
  // Existing content is intentionally not interpreted: this boundary is content-neutral.
  void params.existingContent;
  const proposedLines = splitLines(params.content);
  assertHardBounds(proposedLines, params.content);
  return {
    status: "accepted",
    content: params.content,
    appendedLines: proposedLines.length,
    appendChars: params.content.length,
  };
}
