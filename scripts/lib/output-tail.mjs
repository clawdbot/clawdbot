// Keeps child-process diagnostic tails byte-bounded without splitting UTF-8 characters.

function outputText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return "";
}

function decodeUtf8Tail(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}

export function outputTail(value, maxBytes) {
  const text = outputText(value).trim();
  if (!text) {
    return "";
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  return decodeUtf8Tail(bytes.subarray(bytes.byteLength - maxBytes));
}
