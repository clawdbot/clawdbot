/** Parses a Content-Length header as a safe integer or rejects malformed values. */
export function parseMediaContentLength(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`invalid content-length header: ${raw}`);
  }
  const size = Number(trimmed);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`invalid content-length header: ${raw}`);
  }
  return size;
}
