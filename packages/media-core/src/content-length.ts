/** Parses a Content-Length header as a safe integer or rejects malformed values. */
export function parseMediaContentLength(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const values = raw.split(",").map((value) => value.replace(/^[\t ]+|[\t ]+$/g, ""));
  const value = values[0] ?? "";
  // Repeated lengths affect framing, so their trimmed decimal bytes must match.
  // Numeric comparison would wrongly accept ambiguous values such as "05, 5".
  if (!/^\d+$/.test(value) || values.some((candidate) => candidate !== value)) {
    throw new Error(`invalid content-length header: ${raw}`);
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`invalid content-length header: ${raw}`);
  }
  return size;
}
