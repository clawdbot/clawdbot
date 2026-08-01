/**
 * Private temporary file helper for tool output spillover.
 *
 * Creates owner-only log files without reusing predictable names.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Opens a unique write stream with owner-only permissions. */
export function createPrivateTempWriteStream(prefix: string): {
  path: string;
  stream: WriteStream;
} {
  const filePath = createPrivateTempFilePath(prefix);
  return {
    path: filePath,
    stream: createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
  };
}

export async function writePrivateTempFile(prefix: string, content: string): Promise<string> {
  const filePath = createPrivateTempFilePath(prefix);
  await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  return filePath;
}

function createPrivateTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}
