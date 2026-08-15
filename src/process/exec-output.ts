import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";

export type CommandOutputCaptureMode = "head" | "tail" | "discard";
export type CommandOutputStream = "stdout" | "stderr";
export type CommandOutputCaptureOption =
  | CommandOutputCaptureMode
  | { stdout?: CommandOutputCaptureMode; stderr?: CommandOutputCaptureMode };
export type CommandOutputLimitOption =
  | boolean
  | { stdout?: boolean; stderr?: boolean; combined?: boolean };
export type PreserveOutputLine = (line: string, stream: CommandOutputStream) => boolean;

export type CapturedOutputBuffers = {
  chunks: Buffer[];
  bytes: number;
  truncatedBytes: number;
  preservedLines: string[];
  decoder: StringDecoder;
  pendingLine: string;
};

const DEFAULT_COMMAND_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_PRESERVED_PENDING_LINE_BYTES = 8 * 1024;

export function createCapturedOutputBuffers(): CapturedOutputBuffers {
  return {
    chunks: [],
    bytes: 0,
    truncatedBytes: 0,
    preservedLines: [],
    decoder: new StringDecoder("utf8"),
    pendingLine: "",
  };
}

function normalizeMaxOutputBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMMAND_OUTPUT_MAX_BYTES;
  }
  return Math.max(1, Math.floor(value));
}

export function resolveMaxOutputBytes(
  value: number | { stdout?: number; stderr?: number } | undefined,
  stream: CommandOutputStream,
): number {
  return normalizeMaxOutputBytes(typeof value === "number" ? value : value?.[stream]);
}

export function resolveOutputCapture(
  value: CommandOutputCaptureOption | undefined,
  stream: CommandOutputStream,
): CommandOutputCaptureMode {
  return (typeof value === "string" ? value : value?.[stream]) ?? "tail";
}

export function shouldTerminateOnOutputLimit(
  value: CommandOutputLimitOption | undefined,
  limit: CommandOutputStream | "combined",
): boolean {
  return typeof value === "boolean" ? value : value?.[limit] === true;
}

export function appendCapturedOutput(
  capture: CapturedOutputBuffers,
  chunk: Buffer | string,
  maxBytes: number,
  mode: CommandOutputCaptureMode,
): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (mode === "discard") {
    capture.truncatedBytes += buffer.byteLength;
    return;
  }
  if (mode === "head") {
    const remaining = Math.max(0, maxBytes - capture.bytes);
    if (remaining > 0) {
      const kept = buffer.subarray(0, remaining);
      capture.chunks.push(kept);
      capture.bytes += kept.byteLength;
    }
    capture.truncatedBytes += Math.max(0, buffer.byteLength - remaining);
    return;
  }
  if (buffer.byteLength >= maxBytes) {
    capture.chunks = [Buffer.from(buffer.subarray(buffer.byteLength - maxBytes))];
    capture.truncatedBytes += capture.bytes + buffer.byteLength - maxBytes;
    capture.bytes = maxBytes;
    return;
  }

  capture.chunks.push(buffer);
  capture.bytes += buffer.byteLength;
  while (capture.bytes > maxBytes && capture.chunks.length > 0) {
    const first = expectDefined(capture.chunks[0], "chunks entry at 0");
    const overflow = capture.bytes - maxBytes;
    if (first.byteLength <= overflow) {
      capture.chunks.shift();
      capture.bytes -= first.byteLength;
      capture.truncatedBytes += first.byteLength;
    } else {
      capture.chunks[0] = Buffer.from(first.subarray(overflow));
      capture.bytes -= overflow;
      capture.truncatedBytes += overflow;
    }
  }
}

function trimTruncatedUtf8Boundary(
  buffer: Buffer,
  mode: CommandOutputCaptureMode,
  truncatedBytes: number,
  forceUtf8: boolean,
): Buffer {
  if (truncatedBytes === 0 || buffer.length === 0 || (process.platform === "win32" && !forceUtf8)) {
    return buffer;
  }
  if (mode === "tail") {
    let start = 0;
    while (start < buffer.length && (expectDefined(buffer[start], "buffer byte") & 0xc0) === 0x80) {
      start += 1;
    }
    return buffer.subarray(start);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let removed = 0; removed <= 3 && removed <= buffer.length; removed += 1) {
    const end = buffer.length - removed;
    try {
      decoder.decode(buffer.subarray(0, end));
      return buffer.subarray(0, end);
    } catch {
      // A UTF-8 code point is at most four bytes; try the preceding boundary.
    }
  }
  return buffer;
}

export function finalizeCapturedOutput(
  capture: CapturedOutputBuffers,
  mode: CommandOutputCaptureMode,
  forceUtf8 = false,
): Buffer {
  const buffered = Buffer.concat(capture.chunks, capture.bytes);
  const trimmed = trimTruncatedUtf8Boundary(buffered, mode, capture.truncatedBytes, forceUtf8);
  capture.truncatedBytes += buffered.byteLength - trimmed.byteLength;
  return trimmed;
}

function trimPreservedPendingLine(value: string, maxBytes: number): string {
  return truncateUtf8Suffix(value, maxBytes);
}

export function appendPreservedOutputLines(params: {
  capture: CapturedOutputBuffers;
  chunk: Buffer | string;
  stream: CommandOutputStream;
  preserveOutputLine?: PreserveOutputLine;
  maxPreservedOutputLines: number;
  maxPendingLineBytes: number;
}): void {
  if (!params.preserveOutputLine || params.maxPreservedOutputLines <= 0) {
    return;
  }
  const text = Buffer.isBuffer(params.chunk)
    ? params.capture.decoder.write(params.chunk)
    : params.chunk;
  if (!text) {
    return;
  }
  const lines = (params.capture.pendingLine + text).split(/\r?\n/);
  params.capture.pendingLine = trimPreservedPendingLine(
    lines.pop() ?? "",
    params.maxPendingLineBytes,
  );
  for (const line of lines) {
    if (
      params.capture.preservedLines.length < params.maxPreservedOutputLines &&
      params.preserveOutputLine(line, params.stream)
    ) {
      params.capture.preservedLines.push(line);
    }
  }
}

export function flushPreservedOutputLine(params: {
  capture: CapturedOutputBuffers;
  stream: CommandOutputStream;
  preserveOutputLine?: PreserveOutputLine;
  maxPreservedOutputLines: number;
  maxPendingLineBytes: number;
}): void {
  if (!params.preserveOutputLine || params.maxPreservedOutputLines <= 0) {
    return;
  }
  const trailing = trimPreservedPendingLine(
    params.capture.pendingLine + params.capture.decoder.end(),
    params.maxPendingLineBytes,
  );
  params.capture.pendingLine = "";
  if (
    trailing &&
    params.capture.preservedLines.length < params.maxPreservedOutputLines &&
    params.preserveOutputLine(trailing, params.stream)
  ) {
    params.capture.preservedLines.push(trailing);
  }
}
