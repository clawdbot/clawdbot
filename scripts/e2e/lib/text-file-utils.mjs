// Text file tail helpers for E2E assertions.
import fs from "node:fs";

export function tailText(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8");
}

export function readTextFileTail(file, maxBytes) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return "";
  }
  if (!stat.isFile() || stat.size <= 0) {
    return "";
  }

  const length = Math.min(maxBytes, stat.size);
  const start = stat.size - length;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
