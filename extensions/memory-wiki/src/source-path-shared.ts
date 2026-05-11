import fs from "node:fs/promises";
import path from "node:path";
import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/string-coerce-runtime";

export async function resolveArtifactKey(absolutePath: string): Promise<string> {
  const canonicalPath = await fs.realpath(absolutePath).catch(() => path.resolve(absolutePath));
  return process.platform === "win32"
    ? lowercasePreservingWhitespace(canonicalPath)
    : canonicalPath;
}
