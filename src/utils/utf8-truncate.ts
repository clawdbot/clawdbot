import { Buffer } from "node:buffer";

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function truncateEncodedPrefix(bytes: Buffer, maxBytes: number): string {
  let end = maxBytes;
  while (end > 0 && isContinuationByte(bytes[end])) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

/** Keeps the longest UTF-8 prefix that fits within the byte limit. */
export function truncateUtf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (value.length <= maxBytes && Buffer.byteLength(value) <= maxBytes) {
    return value;
  }
  // Only this many UTF-16 units can contribute to the retained UTF-8 prefix.
  return truncateEncodedPrefix(Buffer.from(value.slice(0, maxBytes)), maxBytes);
}

/** Keeps the longest UTF-8 suffix that fits within the byte limit. */
export function truncateUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (value.length <= maxBytes && Buffer.byteLength(value) <= maxBytes) {
    return value;
  }
  // Full length matters: fractional subtraction rounds before index conversion.
  const bytes = Buffer.from(value);
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && isContinuationByte(bytes[start])) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}
