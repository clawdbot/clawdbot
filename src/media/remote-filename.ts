/**
 * Decoders for remote media filenames taken from Content-Disposition headers
 * (RFC 5987 extended values and percent-encoded components). Split out of
 * fetch.ts to keep that module under the max-lines budget.
 */

export function decodeRemoteFileNameComponent(value: string): string {
  try {
    return decodeURIComponent(value).replace(/[\\/]/g, "_");
  } catch {
    return value;
  }
}

export function decodeExtendedRemoteFileName(value: string): string | undefined {
  const match = /^([^']*)'[^']*'(.*)$/u.exec(value);
  if (!match) {
    return undefined;
  }
  const charset = match[1]?.toLowerCase();
  const encoded = match[2] ?? "";
  try {
    if (charset === "utf-8") {
      return decodeURIComponent(encoded).replace(/[\\/]/g, "_");
    }
    if (charset === "iso-8859-1") {
      if (/%(?![\da-f]{2})/iu.test(encoded)) {
        return undefined;
      }
      return encoded
        .replace(/%([\da-f]{2})/giu, (_match, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        )
        .replace(/[\\/]/g, "_");
    }
  } catch {
    return undefined;
  }
  return undefined;
}
