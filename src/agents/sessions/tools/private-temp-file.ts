/**
 * Private temporary file helper for tool output spillover.
 *
 * Creates owner-only log files without reusing predictable names.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Opens a unique write stream with owner-only permissions. */
export function createPrivateTempWriteStream(prefix: string): {
  path: string;
  stream: WriteStream;
} {
  const id = randomBytes(8).toString("hex");
  const filePath = join(tmpdir(), `${prefix}-${id}.log`);
  return {
    path: filePath,
    stream: createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
  };
}
