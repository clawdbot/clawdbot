const strictUtf8FileDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/** Reject invalid file bytes without stripping a valid leading UTF-8 BOM. */
export function decodeUtf8File(contents: Buffer, filePath: string): string {
  try {
    return strictUtf8FileDecoder.decode(contents);
  } catch (error) {
    throw new Error(`File ${filePath} is not valid UTF-8 and cannot be edited safely.`, {
      cause: error,
    });
  }
}
