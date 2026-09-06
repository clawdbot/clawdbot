import type { PathLike } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function nodeFilePath(filePath: PathLike | FileHandle): string | undefined {
  if (typeof filePath === "string") {
    return filePath;
  }
  if (Buffer.isBuffer(filePath)) {
    return filePath.toString("utf8");
  }
  return filePath instanceof URL ? fileURLToPath(filePath) : undefined;
}
