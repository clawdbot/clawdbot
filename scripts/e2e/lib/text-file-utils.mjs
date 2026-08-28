// Text file tail helpers for E2E assertions.
import fs from "node:fs";

function decodeUtf8Tail(buffer, truncated) {
  let start = 0;
  if (truncated) {
    while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
      start += 1;
    }
  }
  return buffer.subarray(start).toString("utf8");
}

export function tailText(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  return decodeUtf8Tail(Buffer.from(text, "utf8").subarray(-maxBytes), true);
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
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return decodeUtf8Tail(buffer.subarray(0, bytesRead), start > 0);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Tail diagnostics are best-effort; callers may be preserving a richer error.
      }
    }
  }
}

function textFileTooLargeError(message) {
  return Object.assign(new Error(message), { code: "ETOOBIG" });
}

export function readTextFileBounded(file, label, maxBytes, options = {}) {
  const tailBytes = options.tailBytes ?? 16 * 1024;
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`${label} is not a file: ${file}`);
  }
  if (stat.size > maxBytes) {
    throw textFileTooLargeError(
      `${label} exceeded ${maxBytes} bytes: ${file} (${stat.size} bytes). Tail: ${readTextFileTail(
        file,
        tailBytes,
      )}`,
    );
  }
  const text = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw textFileTooLargeError(
      `${label} exceeded ${maxBytes} bytes: ${file} (${bytes} bytes). Tail: ${readTextFileTail(
        file,
        tailBytes,
      )}`,
    );
  }
  return text;
}
