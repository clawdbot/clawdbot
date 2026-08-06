import { Buffer } from "node:buffer";

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Keeps the longest UTF-8 prefix that fits within the byte limit. */
export function truncateUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end])) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/** Keeps the longest UTF-8 suffix that fits within the byte limit. */
export function truncateUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && isContinuationByte(bytes[start])) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}
