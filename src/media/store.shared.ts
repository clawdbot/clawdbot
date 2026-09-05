import { formatByteSize } from "@openclaw/normalization-core";

// Media files remain readable by sandbox container UIDs; the private media
// directory is the trust boundary. Temp and final writes must use one mode.
export const MEDIA_FILE_MODE = 0o644;

export function formatMediaSize(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "mega",
    separator: "",
    fractionDigits: (value) => (Number.isInteger(value) ? 0 : 2),
  });
}

/** Stable error categories for unsafe or failed source-file ingestion. */
type SaveMediaSourceErrorCode =
  | "invalid-path"
  | "not-found"
  | "not-file"
  | "path-mismatch"
  | "too-large";

/** Media persistence failure with a stable category for callers. */
export class SaveMediaSourceError extends Error {
  code: SaveMediaSourceErrorCode;

  constructor(code: SaveMediaSourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "SaveMediaSourceError";
  }

  static tooLarge(maxBytes: number, options?: ErrorOptions): SaveMediaSourceError {
    const limit = formatMediaSize(maxBytes);
    return new SaveMediaSourceError("too-large", `Media exceeds ${limit} limit`, options);
  }
}
