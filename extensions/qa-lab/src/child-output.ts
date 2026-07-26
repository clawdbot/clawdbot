// Qa Lab plugin module implements child output behavior.
import { StringDecoder } from "node:string_decoder";

export const QA_CHILD_STDOUT_MAX_BYTES = 1024 * 1024;
export const QA_CHILD_STDERR_TAIL_BYTES = 64 * 1024;

type QaChildOutputCapture = {
  chunks: Buffer[];
  bytes: number;
  exceeded: boolean;
  maxBytes: number;
};

type QaChildOutputTail = {
  buffer: Buffer;
  maxBytes: number;
  truncated: boolean;
};

function toBuffer(chunk: unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
}

function decodeUtf8Prefix(buffer: Buffer, truncated: boolean): string {
  return truncated ? new StringDecoder("utf8").write(buffer) : buffer.toString("utf8");
}

function decodeUtf8Tail(buffer: Buffer, truncated: boolean): string {
  let start = 0;
  if (truncated) {
    while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
      start += 1;
    }
  }
  return buffer.subarray(start).toString("utf8");
}

export function createQaChildOutputCapture(maxBytes = QA_CHILD_STDOUT_MAX_BYTES) {
  return {
    chunks: [],
    bytes: 0,
    exceeded: false,
    maxBytes,
  } satisfies QaChildOutputCapture;
}

export function appendQaChildOutput(capture: QaChildOutputCapture, chunk: unknown) {
  if (capture.exceeded) {
    return;
  }
  const buffer = toBuffer(chunk);
  const remainingBytes = capture.maxBytes - capture.bytes;
  if (buffer.byteLength > remainingBytes) {
    if (remainingBytes > 0) {
      capture.chunks.push(Buffer.from(buffer.subarray(0, remainingBytes)));
    }
    capture.bytes = capture.maxBytes;
    capture.exceeded = true;
    return;
  }
  capture.chunks.push(Buffer.from(buffer));
  capture.bytes += buffer.byteLength;
}

export function readQaChildOutput(capture: QaChildOutputCapture) {
  return decodeUtf8Prefix(Buffer.concat(capture.chunks, capture.bytes), capture.exceeded);
}

export function createQaChildOutputTail(maxBytes = QA_CHILD_STDERR_TAIL_BYTES) {
  return {
    buffer: Buffer.alloc(0),
    maxBytes,
    truncated: false,
  } satisfies QaChildOutputTail;
}

export function appendQaChildOutputTail(tail: QaChildOutputTail, chunk: unknown) {
  const buffer = toBuffer(chunk);
  if (buffer.byteLength >= tail.maxBytes) {
    tail.buffer = Buffer.from(buffer.subarray(buffer.byteLength - tail.maxBytes));
    tail.truncated = true;
    return;
  }
  const next = Buffer.concat([tail.buffer, buffer], tail.buffer.byteLength + buffer.byteLength);
  if (next.byteLength <= tail.maxBytes) {
    tail.buffer = next;
    return;
  }
  tail.buffer = Buffer.from(next.subarray(next.byteLength - tail.maxBytes));
  tail.truncated = true;
}

export function formatQaChildOutputTail(tail: QaChildOutputTail, label: string) {
  const text = decodeUtf8Tail(tail.buffer, tail.truncated).trim();
  if (!text) {
    return "";
  }
  return tail.truncated ? `[${label} truncated to last ${tail.maxBytes} bytes]\n${text}` : text;
}
